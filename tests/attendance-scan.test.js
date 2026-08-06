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

test('scan with no timestamp defaults to today, cv and manual map correctly', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/attendance'), ATT);
  t.after(close);
  seedRoster(db);

  const res = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'cv', room_id: 1 }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.attendance.method, 'CV');
  assert.equal(body.attendance.date, new Date().toISOString().slice(0, 10));

  const res2 = await fetch(`${base}${ATT}/scan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ student_id: 1, method: 'manual' }),
  });
  assert.equal(res2.status, 201);
  const body2 = await res2.json();
  assert.equal(body2.attendance.method, 'manual');
  assert.equal(body2.attendance.room_name, null, 'room is optional');
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
  const { total, today_rows, by_method } = await res.json();
  assert.equal(total, 1);
  assert.equal(today_rows.length, 1);
  assert.deepEqual(by_method, [{ method: 'RFID', c: 1 }]);
});
