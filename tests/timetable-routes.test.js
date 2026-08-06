'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, mountRouter } = require('./helpers');
const TT = '/api/timetable';

function seedBasics(db) {
  db.prepare(`INSERT INTO staff (name, subject) VALUES ('R. Iyer', 'Physics')`).run(); // id 1
  db.prepare(`INSERT INTO staff (name, subject) VALUES ('S. Das', 'Maths')`).run();    // id 2
  db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Lab 2', 30, 'lab')`).run();      // id 1
  db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Rm 4', 40, 'classroom')`).run(); // id 2
}

function insertSlot(db, { day, period, subject, staff_id, room_id, class_section }) {
  return db.prepare(
    `INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(day, period, subject, staff_id ?? null, room_id ?? null, class_section).lastInsertRowid;
}

const patchSlot = (base, id, body) => fetch(`${base}${TT}/slots/${id}/reassign`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const delSlot = (base, id) => fetch(`${base}${TT}/slots/${id}`, { method: 'DELETE' });

test('PATCH reassign edits subject/day/period/class/staff/room of a slot', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const id = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '10A' });

  const res = await patchSlot(base, id, {
    day: 2, period: 4, subject: 'Physics', class_section: '9B', staff_id: 1, room_id: 1,
  });
  assert.equal(res.status, 200);
  const { slot, remaining_issues } = await res.json();
  assert.equal(slot.day, 2);
  assert.equal(slot.period, 4);
  assert.equal(slot.subject, 'Physics');
  assert.equal(slot.class_section, '9B');
  assert.equal(slot.staff_id, 1);
  assert.equal(slot.room_id, 1);
  assert.equal(slot.staff_name, 'R. Iyer');
  assert.deepEqual(remaining_issues, [], 'moving to a free cell creates no conflict');
});

test('PATCH with staff_id null clears the teacher (staffing gap)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const id = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '10A' });

  const res = await patchSlot(base, id, { staff_id: null });
  assert.equal(res.status, 200);
  const row = db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(id);
  assert.equal(row.staff_id, null, 'explicit null clears the teacher');
  // The staffing-gap notification is generated for the now-teacherless slot.
  const gap = db.prepare(`SELECT * FROM notifications WHERE fingerprint = ?`).get(`staffing_gap_${id}`);
  assert.ok(gap, 'staffing gap notification exists');
});

test('PATCH validates bad day/period/subject and unknown staff/room', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const id = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '10A' });

  let res = await patchSlot(base, id, { day: 9 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /day/);

  res = await patchSlot(base, id, { period: 0 });
  assert.equal(res.status, 400);

  res = await patchSlot(base, id, { subject: '   ' });
  assert.equal(res.status, 400);

  res = await patchSlot(base, id, { staff_id: 999 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown staff_id/);

  res = await patchSlot(base, id, { room_id: 999 });
  assert.equal(res.status, 400);

  res = await patchSlot(base, 99999, { day: 1 });
  assert.equal(res.status, 404);
});

test('moving a clashing slot to a free period clears BOTH flags and resolves the clash notification', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  // Two classes share Lab 2 (room 1) at Mon P1 → room clash.
  const a = insertSlot(db, { day: 0, period: 1, subject: 'Physics', staff_id: 1, room_id: 1, class_section: '10A' });
  const b = insertSlot(db, { day: 0, period: 1, subject: 'Chemistry', staff_id: 2, room_id: 1, class_section: '10B' });

  // Trigger the scan that flags both + creates the clash notification.
  let res = await fetch(`${base}${TT}/detect-conflicts`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM timetable_slots WHERE conflict = 1`).get().c, 2);
  const notif = db.prepare(`SELECT * FROM notifications WHERE fingerprint = ?`).get(`clash_${b}_0_1`);
  assert.ok(notif && notif.resolved === 0, 'clash notification is open');

  // Move slot b to Mon P2 — the same room, but now alone there.
  res = await patchSlot(base, b, { period: 2 });
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT conflict FROM timetable_slots WHERE id = ?`).get(a).conflict, 0, 'peer flag cleared');
  assert.equal(db.prepare(`SELECT conflict FROM timetable_slots WHERE id = ?`).get(b).conflict, 0, 'moved slot flag cleared');
  const after = db.prepare(`SELECT * FROM notifications WHERE fingerprint = ?`).get(`clash_${b}_0_1`);
  assert.equal(after.resolved, 1, 'old-cell clash notification auto-resolved');
});

test('DELETE removes a slot, clears its peers and resolves its notifications; 404 on missing', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const a = insertSlot(db, { day: 0, period: 1, subject: 'Physics', staff_id: 1, room_id: 1, class_section: '10A' });
  const b = insertSlot(db, { day: 0, period: 1, subject: 'Chemistry', staff_id: 2, room_id: 1, class_section: '10B' });
  await fetch(`${base}${TT}/detect-conflicts`, { method: 'POST' });

  const res = await delSlot(base, a);
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM timetable_slots WHERE id = ?`).get(a).c, 0, 'slot is gone');
  assert.equal(db.prepare(`SELECT conflict FROM timetable_slots WHERE id = ?`).get(b).conflict, 0, 'surviving peer un-flagged');
  assert.equal(
    db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = ?`).get(`clash_${a}_0_1`).resolved, 1,
    'deleted slot\u2019s clash notification resolved'
  );

  const again = await delSlot(base, a);
  assert.equal(again.status, 404);
});

test('editing/deleting slot 1 never touches OTHER slots\' clash notifications (LIKE-prefix safety)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  // Nine quiet slots so the clash pair lands at ids 10/11 — ids whose
  // fingerprints share the 'clash_1_%' LIKE pattern with slot 1's (the `_`
  // wildcard would previously match clash_10_… / clash_11_…).
  for (let i = 0; i < 8; i++) insertSlot(db, { day: 0, period: i + 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '9A' });
  insertSlot(db, { day: 1, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '9A' }); // id 9
  insertSlot(db, { day: 1, period: 4, subject: 'Physics', staff_id: 1, room_id: 1, class_section: '10A' });   // id 10
  insertSlot(db, { day: 1, period: 4, subject: 'Chemistry', staff_id: 2, room_id: 1, class_section: '10B' }); // id 11
  const quiet = 1;
  await fetch(`${base}${TT}/detect-conflicts`, { method: 'POST' });
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_10_1_4'`).get().resolved, 0);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_11_1_4'`).get().resolved, 0);

  // Edit the quiet slot (subject only, same cell) — must not resolve 10/11.
  let res = await patchSlot(base, quiet, { subject: 'English' });
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_10_1_4'`).get().resolved, 0, 'slot 10 notification untouched by edit');
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_11_1_4'`).get().resolved, 0, 'slot 11 notification untouched by edit');

  // Delete the quiet slot — same guarantee.
  res = await delSlot(base, quiet);
  assert.equal(res.status, 200);
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_10_1_4'`).get().resolved, 0, 'slot 10 notification untouched by delete');
  assert.equal(db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = 'clash_11_1_4'`).get().resolved, 0, 'slot 11 notification untouched by delete');
});

test('PATCH rejects soft-deleted (inactive) staff and room', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const id = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '10A' });
  db.prepare(`UPDATE staff SET status = 'inactive' WHERE id = 1`).run();
  db.prepare(`UPDATE rooms SET status = 'inactive' WHERE id = 1`).run();

  let res = await patchSlot(base, id, { staff_id: 1 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown staff_id/);

  res = await patchSlot(base, id, { room_id: 1 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown room_id/);
});

test('PATCH coerces day/period before validating (rejects booleans and floats)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);
  const id = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 2, class_section: '10A' });

  let res = await patchSlot(base, id, { day: 'abc' });
  assert.equal(res.status, 400);
  res = await patchSlot(base, id, { period: 2.5 });
  assert.equal(res.status, 400);
  res = await patchSlot(base, id, { day: 5 });
  assert.equal(res.status, 400, 'day 5 is outside the rendered Mon-Fri grid');
  res = await patchSlot(base, id, { period: 7 });
  assert.equal(res.status, 400, 'period 7 is outside the rendered grid');
  res = await patchSlot(base, id, { day: '2' });
  assert.equal(res.status, 200, 'numeric string coerces cleanly');
});

test('POST /slots creates a slot and validates day/period ranges', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedBasics(db);

  let res = await fetch(`${base}${TT}/slots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: 3, period: 5, subject: 'Hindi', class_section: '9A', staff_id: 1, room_id: 2 }),
  });
  assert.equal(res.status, 201);
  const { slot_id } = await res.json();
  assert.equal(db.prepare(`SELECT subject FROM timetable_slots WHERE id = ?`).get(slot_id).subject, 'Hindi');

  res = await fetch(`${base}${TT}/slots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: 7, period: 1, subject: 'Maths', class_section: '9A' }),
  });
  assert.equal(res.status, 400);

  res = await fetch(`${base}${TT}/slots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: 0, period: 1, class_section: '9A' }),
  });
  assert.equal(res.status, 400, 'subject is required');
});
