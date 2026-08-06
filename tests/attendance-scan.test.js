'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, mountRouter } = require('./helpers');
const ATT = '/api/attendance';

function seedRoster(db) {
  db.prepare(`INSERT INTO students (name, class) VALUES ('Aarav Sharma', '9B')`).run();
  db.prepare(`INSERT INTO rooms (name, capacity) VALUES ('Lab 2', 30)`).run();
}

test('POST /api/attendance/scan writes a real row tagged with the method', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  const res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', room_id: 1, timestamp: '2026-08-05T09:15:00Z' }),
  });
  assert.equal(res.status, 201);
  const { attendance } = await res.json();
  assert.equal(attendance.student_name, 'Aarav Sharma');
  assert.equal(attendance.method, 'RFID', 'rfid is normalized to the schema value');
  assert.equal(attendance.room_name, 'Lab 2');
  assert.equal(attendance.status, 'present');
  assert.equal(attendance.date, '2026-08-05', 'date comes from the timestamp');

  const row = db.prepare(`SELECT * FROM attendance_records WHERE id = ?`).get(attendance.id);
  assert.equal(row.method, 'RFID');
  assert.equal(row.room_id, 1);
});

test('scan with no timestamp defaults to today; cv and manual map correctly', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);
  db.prepare(`INSERT INTO students (name, class) VALUES ('Diya Kapoor', '10A')`).run(); // id 2

  const res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'cv', room_id: 1 }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.attendance.method, 'CV');
  assert.equal(body.attendance.date, new Date().toISOString().slice(0, 10));

  // A DIFFERENT student (one present record per student per day).
  const res2 = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 2, method: 'manual' }),
  });
  assert.equal(res2.status, 201);
  const body2 = await res2.json();
  assert.equal(body2.attendance.method, 'manual');
  assert.equal(body2.attendance.room_name, null, 'room is optional');
});

test('re-scanning the same student the same day is idempotent (RFID double-read / rapid clicks)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  const first = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', room_id: 1, timestamp: '2026-08-05T09:15:00Z' }),
  });
  assert.equal(first.status, 201);
  const firstBody = await first.json();
  assert.equal(firstBody.duplicate, false);

  // A second scan moments later (double-read / double-click) → no new row.
  const dup = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', room_id: 1, timestamp: '2026-08-05T09:15:01Z' }),
  });
  assert.equal(dup.status, 200, 'duplicate returns 200, not 201');
  const dupBody = await dup.json();
  assert.equal(dupBody.duplicate, true);
  assert.equal(dupBody.attendance.id, firstBody.attendance.id, 'returns the existing row');
  assert.equal(
    db.prepare(`SELECT COUNT(*) c FROM attendance_records WHERE student_id = 1 AND date = '2026-08-05'`).get().c,
    1,
    'exactly one present row for that student+day'
  );

  // The next day is a fresh record.
  const next = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', timestamp: '2026-08-06T08:00:00Z' }),
  });
  assert.equal(next.status, 201);
});

test('scan rejects unknown student and unknown room', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  let res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 999, method: 'rfid' }),
  });
  assert.equal(res.status, 404);

  res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', room_id: 999 }),
  });
  assert.equal(res.status, 404);
});

test('scan rejects soft-deleted (inactive) students and rooms', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);
  db.prepare(`UPDATE students SET status = 'inactive' WHERE id = 1`).run();
  db.prepare(`UPDATE rooms SET status = 'inactive' WHERE id = 1`).run();

  let res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid' }),
  });
  assert.equal(res.status, 404, 'inactive student cannot be scanned');

  res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 2, method: 'rfid', room_id: 1 }),
  });
  assert.equal(res.status, 404, 'inactive room cannot be scanned into');
});

test('scan validates method and timestamp', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  let res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'teleport' }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 'abc', method: 'rfid' }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', timestamp: 'not-a-date' }),
  });
  assert.equal(res.status, 400);
});

test('scans appear in the attendance summary (live feed source)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'rfid', room_id: 1 }),
  });

  const res = await fetch(`${base}${ATT}/summary`);
  assert.equal(res.status, 200);
  const { total, today_count, today_rows, by_method } = await res.json();
  assert.equal(total, 1);
  assert.equal(today_count, 1, 'today_count counts today\u2019s live scans');
  assert.equal(today_rows.length, 1);
  assert.equal(today_rows[0].student_name, 'Aarav Sharma');
  assert.deepEqual(by_method, [{ method: 'RFID', c: 1 }]);
});

test('summary excludes historical seed rows from today_rows (live feed = today only)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);
  // A historical row from yesterday — must NOT appear in the live feed.
  db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (1, ?, 'present', 'RFID')`)
    .run(new Date(Date.now() - 86400000).toISOString().slice(0, 10));

  const res = await fetch(`${base}${ATT}/summary`);
  const { today_count, today_rows, total } = await res.json();
  assert.equal(total, 1);
  assert.equal(today_count, 0, 'yesterday\u2019s row is not counted as today');
  assert.equal(today_rows.length, 0, 'feed shows today\u2019s scans only');
});
