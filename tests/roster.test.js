'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, mountRouter } = require('./helpers');
const ROSTER = '/api/roster';

const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const patch = (base, path, body) => fetch(`${base}${path}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const del = (base, path) => fetch(`${base}${path}`, { method: 'DELETE' });

/* ================= students ================= */

test('student CRUD: create, list, update, soft-delete', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  // Create
  let res = await post(base, `${ROSTER}/students`, { name: 'Zoya Khan', class: '10A', guardian_contact: '+91 90000 00000' });
  assert.equal(res.status, 201);
  const { student } = await res.json();
  assert.equal(student.status, 'active');

  // List (default: active only)
  res = await fetch(`${base}${ROSTER}/students`);
  let { students } = await res.json();
  assert.equal(students.length, 1);
  assert.equal(students[0].name, 'Zoya Khan');

  // Update
  res = await patch(base, `${ROSTER}/students/${student.id}`, { class: '10B', section: 'A' });
  assert.equal(res.status, 200);
  const updated = (await res.json()).student;
  assert.equal(updated.class, '10B');
  assert.equal(updated.section, 'A');

  // Soft delete
  res = await del(base, `${ROSTER}/students/${student.id}`);
  assert.equal(res.status, 200);
  const row = db.prepare(`SELECT * FROM students WHERE id = ?`).get(student.id);
  assert.equal(row.status, 'inactive', 'row stays in the table — no orphaned references');

  // Hidden by default, visible with include_inactive
  res = await fetch(`${base}${ROSTER}/students`);
  students = (await res.json()).students;
  assert.equal(students.length, 0, 'inactive students are excluded by default');
  res = await fetch(`${base}${ROSTER}/students?include_inactive=1`);
  students = (await res.json()).students;
  assert.equal(students.length, 1);

  // Restore via PATCH status
  res = await patch(base, `${ROSTER}/students/${student.id}`, { status: 'active' });
  assert.equal(res.status, 200);
  res = await fetch(`${base}${ROSTER}/students`);
  assert.equal((await res.json()).students.length, 1, 'restored student is visible again');
});

test('student validation: missing name/class, bad status, non-string fields are rejected', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  let res = await post(base, `${ROSTER}/students`, { class: '10A' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /name/);

  res = await post(base, `${ROSTER}/students`, { name: 'Zoya' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /class/);

  res = await post(base, `${ROSTER}/students`, { name: 'Zoya', class: '10A', status: 'banished' });
  assert.equal(res.status, 400);

  // A non-string optional field must be a clean 400, not a bind crash.
  const created = await post(base, `${ROSTER}/students`, { name: 'Zoya', class: '10A' });
  const { student } = await created.json();
  res = await patch(base, `${ROSTER}/students/${student.id}`, { section: { evil: true } });
  assert.equal(res.status, 400);
  res = await patch(base, `${ROSTER}/students/${student.id}`, { guardian_contact: ['x'] });
  assert.equal(res.status, 400);

  // PATCH unknown id
  res = await patch(base, `${ROSTER}/students/999`, { class: '10B' });
  assert.equal(res.status, 404);
  // DELETE unknown id
  res = await del(base, `${ROSTER}/students/999`);
  assert.equal(res.status, 404);
});

test('DELETE is idempotent: deleting an already-inactive row is still 200', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  const created = await post(base, `${ROSTER}/students`, { name: 'Zoya', class: '10A' });
  const { student } = await created.json();
  assert.equal((await del(base, `${ROSTER}/students/${student.id}`)).status, 200);
  assert.equal((await del(base, `${ROSTER}/students/${student.id}`)).status, 200, 'second delete is not a 404');
});

/* ================= staff ================= */

test('staff CRUD: create, update, soft-delete, include_inactive', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  let res = await post(base, `${ROSTER}/staff`, { name: 'A. Kumar', subject: 'Physics', contact: 'ext 42' });
  assert.equal(res.status, 201);
  const { staff } = await res.json();
  assert.equal(staff.status, 'active');

  res = await patch(base, `${ROSTER}/staff/${staff.id}`, { subject: 'Chemistry' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).staff.subject, 'Chemistry');

  res = await del(base, `${ROSTER}/staff/${staff.id}`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT status FROM staff WHERE id = ?`).get(staff.id).status, 'inactive');

  res = await fetch(`${base}${ROSTER}/staff`);
  assert.equal((await res.json()).staff.length, 0);
  res = await fetch(`${base}${ROSTER}/staff?include_inactive=1`);
  assert.equal((await res.json()).staff.length, 1);

  res = await post(base, `${ROSTER}/staff`, { subject: 'Physics' });
  assert.equal(res.status, 400);
});

/* ================= rooms ================= */

test('rooms CRUD: create with type/capacity, update, soft-delete', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  let res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', capacity: 24, room_type: 'lab' });
  assert.equal(res.status, 201);
  const { room } = await res.json();
  assert.equal(room.room_type, 'lab');
  assert.equal(room.capacity, 24);

  res = await patch(base, `${ROSTER}/rooms/${room.id}`, { capacity: 30 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).room.capacity, 30);

  res = await del(base, `${ROSTER}/rooms/${room.id}`);
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT status FROM rooms WHERE id = ?`).get(room.id).status, 'inactive');
  res = await fetch(`${base}${ROSTER}/rooms`);
  assert.equal((await res.json()).rooms.length, 0);
});

test('room validation: bad capacity/type → 400, duplicate name → 409', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/roster'), ROSTER);
  t.after(close);

  let res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', capacity: -3 });
  assert.equal(res.status, 400);
  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', capacity: true });
  assert.equal(res.status, 400, 'boolean capacity is rejected');
  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', capacity: '0x10' });
  assert.equal(res.status, 400, 'hex string capacity is rejected');
  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', capacity: 12.5 });
  assert.equal(res.status, 400);

  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9', room_type: 'gym' });
  assert.equal(res.status, 400);

  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9' });
  assert.equal(res.status, 201);
  res = await post(base, `${ROSTER}/rooms`, { name: 'Lab 9' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already exists/);

  res = await patch(base, `${ROSTER}/rooms/999`, { capacity: 10 });
  assert.equal(res.status, 404);
});
