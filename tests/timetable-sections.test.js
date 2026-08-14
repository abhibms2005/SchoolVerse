'use strict';
// Section-specific timetable view + GLOBAL generation — the architectural
// contract of the refactor:
//   * POST /api/timetable/generate solves EVERY section together (teacher,
//     room and per-section constraints are global) in one atomic transaction.
//   * GET /api/timetable?section=X returns only that section, plus the real
//     section list the admin selector is built from (never hard-coded).
//   * Editing a slot touches only that slot, and conflict detection still
//     validates the final grid.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb, mountRouter } = require('./helpers');
const TT = '/api/timetable';

// Seed the generator's real input tables (classes, subjects, requirements,
// staff qualifications, rooms) exactly like routes/timetable.js reads them.
function seedGenerator(db) {
  const staff = {
    iyer: db.prepare(`INSERT INTO staff (name, subject) VALUES ('R. Iyer', 'Physics')`).run().lastInsertRowid,
    das: db.prepare(`INSERT INTO staff (name, subject) VALUES ('S. Das', 'Maths')`).run().lastInsertRowid,
    mehta: db.prepare(`INSERT INTO staff (name, subject) VALUES ('P. Mehta', 'English')`).run().lastInsertRowid,
  };
  const rooms = {
    lab: db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Lab 1', 30, 'lab')`).run().lastInsertRowid,
    rm1: db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Rm 1', 40, 'classroom')`).run().lastInsertRowid,
    rm2: db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Rm 2', 40, 'classroom')`).run().lastInsertRowid,
  };
  const classes = {};
  for (const name of ['9A', '9B', '10A']) {
    classes[name] = db.prepare(`INSERT INTO classes (name) VALUES (?)`).run(name).lastInsertRowid;
  }
  const subjects = {};
  for (const name of ['Maths', 'Physics', 'English']) {
    subjects[name] = db.prepare(`INSERT INTO subjects (name) VALUES (?)`).run(name).lastInsertRowid;
  }
  const req = db.prepare(`INSERT INTO class_subject_requirements (class_id, subject_id, periods_per_week, room_type) VALUES (?, ?, ?, ?)`);
  for (const name of ['9A', '9B', '10A']) {
    req.run(classes[name], subjects.Maths, 5, 'classroom');
    req.run(classes[name], subjects.Physics, 3, 'lab');
    req.run(classes[name], subjects.English, 2, 'classroom');
  }
  const qual = db.prepare(`INSERT INTO staff_subjects (staff_id, subject_id, max_periods_per_week) VALUES (?, ?, ?)`);
  qual.run(staff.das, subjects.Maths, 25);
  qual.run(staff.iyer, subjects.Physics, 25);
  qual.run(staff.mehta, subjects.English, 25);
  return { staff, rooms, classes, subjects };
}

function generate(base) {
  return fetch(`${base}${TT}/generate`, { method: 'POST' });
}

test('A + B + C + D: generation schedules every section at once with no teacher/room/section double-booking', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);

  const res = await generate(base);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.summary.unresolved, 0, 'every requirement placed');

  // A: each section received its own full schedule (10 periods each).
  for (const sec of ['9A', '9B', '10A']) {
    assert.equal(body.slots.filter((s) => s.class_section === sec).length, 10, `${sec} got its 10 required periods`);
  }

  // D: a section never has two slots in the same (day, period).
  for (const s of body.slots) {
    const dups = body.slots.filter((x) => x.day === s.day && x.period === s.period && x.class_section === s.class_section);
    assert.equal(dups.length, 1, `section double-booked at day ${s.day} period ${s.period}`);
  }

  // B + C: at any (day, period) a teacher and a room appear at most once —
  // across ALL sections, proving generation is global, not per-section.
  const cells = {};
  for (const s of body.slots) {
    const key = `${s.day}:${s.period}`;
    (cells[key] = cells[key] || []).push(s);
  }
  assert.ok(Object.keys(cells).length >= 15, 'cells are shared across sections (a global solve, not per-section fills)');
  for (const key of Object.keys(cells)) {
    const cellSlots = cells[key];
    const staffIds = cellSlots.map((s) => s.staff_id).filter((id) => id != null);
    assert.equal(new Set(staffIds).size, staffIds.length, `teacher double-booked in cell ${key}`);
    const roomIds = cellSlots.map((s) => s.room_id).filter((id) => id != null);
    assert.equal(new Set(roomIds).size, roomIds.length, `room double-booked in cell ${key}`);
  }
});

test('E: generated assignments respect teacher qualifications (staff_subjects)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);

  const res = await generate(base);
  assert.equal(res.status, 200);
  const { slots } = await res.json();

  const qualified = db.prepare(
    `SELECT ss.staff_id, s.name AS subject
       FROM staff_subjects ss JOIN subjects s ON s.id = ss.subject_id`
  ).all();
  for (const s of slots) {
    const canTeach = qualified.filter((q) => q.staff_id === s.staff_id).map((q) => q.subject);
    assert.ok(canTeach.includes(s.subject), `staff ${s.staff_id} is not qualified for ${s.subject}`);
  }
  // Every slot that lands in the lab room is a lab requirement (Physics);
  // classroom-only requirements never land in the lab.
  const labId = db.prepare(`SELECT id FROM rooms WHERE room_type = 'lab'`).get().id;
  for (const s of slots.filter((x) => x.room_id === labId)) {
    assert.equal(s.subject, 'Physics', 'only lab-typed subjects use the lab room');
  }
});

test('F: GET /api/timetable?section=9A returns only 9A plus the real section list', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);
  await generate(base);

  const all = await (await fetch(`${base}${TT}`)).json();
  assert.deepEqual(all.sections, ['10A', '9A', '9B'], 'selector list comes from real data, sorted');
  assert.equal(new Set(all.slots.map((s) => s.class_section)).size, 3);

  const res = await fetch(`${base}${TT}?section=9A`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.slots.length > 0);
  assert.ok(body.slots.every((s) => s.class_section === '9A'), 'only the requested section comes back');
  assert.ok(body.sections.includes('9A') && body.sections.includes('10B') === false);
  // Unknown section → empty grid, clean 200 (the UI shows the empty state).
  const none = await (await fetch(`${base}${TT}?section=ZZZ`)).json();
  assert.deepEqual(none.slots, []);
});

test('G: editing one section\u2019s slot changes only that slot', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);
  await generate(base);

  const before = db.prepare(`SELECT id, day, period, subject, staff_id, room_id, class_section FROM timetable_slots ORDER BY id`).all();
  const target = before.find((s) => s.class_section === '9A');
  assert.ok(target, '9A has slots to edit');

  const res = await fetch(`${base}${TT}/slots/${target.id}/reassign`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ day: target.day === 4 ? 0 : target.day + 1, period: target.period === 6 ? 1 : target.period + 1 }),
  });
  assert.equal(res.status, 200);

  const after = db.prepare(`SELECT id, day, period, subject, staff_id, room_id, class_section FROM timetable_slots ORDER BY id`).all();
  assert.equal(after.length, before.length, 'no slot added or removed');
  const changed = after.filter((row, i) => JSON.stringify(row) !== JSON.stringify(before[i]));
  assert.equal(changed.length, 1, 'exactly one slot changed');
  assert.equal(changed[0].id, target.id, 'and it is the slot that was edited');
});

test('H: conflict detection still flags teacher/room double-bookings after the refactor', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);

  // Two different sections sharing the same room at Mon P1 → room clash.
  const lab = db.prepare(`SELECT id FROM rooms WHERE room_type = 'lab'`).get().id;
  const iyer = db.prepare(`SELECT id FROM staff WHERE name = 'R. Iyer'`).get().id;
  const das = db.prepare(`SELECT id FROM staff WHERE name = 'S. Das'`).get().id;
  const ins = db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run(0, 1, 'Physics', iyer, lab, '9A');
  ins.run(0, 1, 'Physics', das, lab, '9B');

  const res = await fetch(`${base}${TT}/detect-conflicts`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.flagged_slots, 2, 'both sides of the clash are flagged');
  const notifs = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'clash' AND resolved = 0`).get().c;
  assert.equal(notifs, 2, 'clash notifications generated for both slots');
});

test('I: failed generation leaves the previous timetable fully intact (atomic)', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  seedGenerator(db);

  // Baseline: a valid generated timetable exists.
  let res = await generate(base);
  assert.equal(res.status, 200);
  const before = db.prepare(`SELECT id, day, period, subject, staff_id, room_id, class_section FROM timetable_slots ORDER BY id`).all();
  assert.ok(before.length > 0);

  // Force every INSERT inside the generation transaction to fail (the route
  // wipes + bulk-inserts inside one better-sqlite3 transaction).
  db.exec(`CREATE TRIGGER fail_generation BEFORE INSERT ON timetable_slots BEGIN SELECT RAISE(ABORT, 'test-forced failure'); END`);
  res = await generate(base);
  assert.equal(res.status, 500, 'generation reports failure');
  const after = db.prepare(`SELECT id, day, period, subject, staff_id, room_id, class_section FROM timetable_slots ORDER BY id`).all();
  assert.deepEqual(after, before, 'no partial data: old timetable untouched (DELETE rolled back too)');
  db.exec(`DROP TRIGGER fail_generation`);
});

test('J: section filter + global generation coexist with the section list on legacy data', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  // No classes table rows at all — a pre-generator database that only has
  // slots. The selector must still be derivable from real slot data.
  const das = db.prepare(`INSERT INTO staff (name, subject) VALUES ('S. Das', 'Maths')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (0, 1, 'Maths', ?, NULL, '9A')`).run(das);
  db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (0, 2, 'Maths', ?, NULL, '10A')`).run(das);

  const body = await (await fetch(`${base}${TT}`)).json();
  assert.deepEqual(body.sections, ['10A', '9A'], 'sections derived from live slot data when classes table is empty');
  const nine = await (await fetch(`${base}${TT}?section=9A`)).json();
  assert.equal(nine.slots.length, 1);
  assert.equal(nine.slots[0].class_section, '9A');
});

test('GET /api/timetable still returns active staff/room picklists for the editor', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/timetable'), TT);
  t.after(close);
  db.prepare(`INSERT INTO staff (name, subject) VALUES ('R. Iyer', 'Physics')`).run();
  db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Lab 1', 30, 'lab')`).run();
  db.prepare(`INSERT INTO staff (name, subject, status) VALUES ('Gone', 'Maths', 'inactive')`).run();
  db.prepare(`INSERT INTO rooms (name, capacity, room_type, status) VALUES ('Old', 10, 'classroom', 'inactive')`).run();

  const body = await (await fetch(`${base}${TT}`)).json();
  assert.deepEqual(body.staff.map((s) => s.name), ['R. Iyer']);
  assert.deepEqual(body.rooms.map((r) => r.name), ['Lab 1']);
});
