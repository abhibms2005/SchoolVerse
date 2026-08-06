'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDb } = require('./helpers');
const { runScan, CONSECUTIVE_ABSENCE_THRESHOLD } = require('../src/notification-service');

function seedStudentWithAbsences(db, absentDates, { presentDates = [] } = {}) {
  const sid = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('A. Absent', '9A', 'A', 'active')`).run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, ?, ?, 'RFID')`);
  for (const d of absentDates) ins.run(sid, d, 'absent');
  for (const d of presentDates) ins.run(sid, d, 'present');
  return sid;
}

test('no alert below the threshold (2 consecutive days)', () => {
  const db = makeDb();
  seedStudentWithAbsences(db, ['2026-01-12', '2026-01-13']); // Mon+Tue
  runScan(db);
  const c = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'absence'`).get().c;
  assert.equal(c, 0);
});

test('alert fires exactly at the threshold (3 consecutive days)', () => {
  const db = makeDb();
  const sid = seedStudentWithAbsences(db, ['2026-01-12', '2026-01-13', '2026-01-14']);
  runScan(db);
  const row = db.prepare(`SELECT * FROM notifications WHERE type = 'absence'`).get();
  assert.ok(row, 'absence alert created');
  assert.equal(row.student_id, sid);
  assert.match(row.message, /3 consecutive days/);
  assert.equal(row.resolved, 0);
});

test('a gap in the calendar breaks the run (no alert)', () => {
  const db = makeDb();
  // Mon, Tue, then Fri — the Thu gap ends the run at 2.
  seedStudentWithAbsences(db, ['2026-01-12', '2026-01-13', '2026-01-16']);
  runScan(db);
  const c = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'absence'`).get().c;
  assert.equal(c, 0);
});

test('attending resets the alert (resolved)', () => {
  const db = makeDb();
  const sid = seedStudentWithAbsences(db, ['2026-01-12', '2026-01-13', '2026-01-14']);
  runScan(db);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE type = 'absence'`).get().resolved, 0);
  // Student attends the next day → run of 3 ends with a present record.
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-15', 'present', 'RFID')`).run(sid);
  runScan(db);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE type = 'absence'`).get().resolved, 1);
});

test('repeated scans never duplicate the alert; re-absence re-opens it', () => {
  const db = makeDb();
  const sid = seedStudentWithAbsences(db, ['2026-01-12', '2026-01-13', '2026-01-14']);
  runScan(db);
  runScan(db);
  runScan(db);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'absence'`).get().c, 1);
  // Attend → resolved; absent again for 3 → re-opened (same fingerprint).
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-15', 'present', 'RFID')`).run(sid);
  runScan(db);
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-19', 'absent', 'RFID')`).run(sid);
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-20', 'absent', 'RFID')`).run(sid);
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-21', 'absent', 'RFID')`).run(sid);
  runScan(db);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'absence'`).get().c, 1);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE type = 'absence'`).get().resolved, 0);
});

test('empty database: scan does not crash and creates nothing', () => {
  const db = makeDb();
  runScan(db); // no students, no attendance — must be a clean no-op
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM notifications`).get().c, 0);
});

test('threshold constant is exported and sane', () => {
  assert.equal(CONSECUTIVE_ABSENCE_THRESHOLD, 3);
});
