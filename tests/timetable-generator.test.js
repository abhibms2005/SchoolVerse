'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateTimetable } = require('../src/timetable-generator');
const { makeDb } = require('./helpers');
const { scanAllConflicts } = require('../src/conflict-detector');

const rooms = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Room ${i + 1}`, room_type: 'classroom' }));
const staff = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, subjects: ['Maths', 'English', 'Science'], max_periods_per_week: 9 }));

function insertGenerated(db, slots) {
  const ins = db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const s of slots) ins.run(s.day, s.period, s.subject, s.staff_id, s.room_id, s.class_section);
}

test('small timetable: no double-bookings, all constraints respected, fully placed', () => {
  const result = generateTimetable({
    rooms: rooms(2),
    staff: staff(2),
    requirements: [
      { class_section: '9A', subject: 'Maths', periods_per_week: 3, room_type: 'classroom' },
      { class_section: '9B', subject: 'Maths', periods_per_week: 3, room_type: 'classroom' },
      { class_section: '10A', subject: 'English', periods_per_week: 3, room_type: 'classroom' },
      { class_section: '10B', subject: 'English', periods_per_week: 3, room_type: 'classroom' },
    ],
    periodsPerDay: 3,
    daysPerWeek: 5,
  });

  assert.equal(result.summary.requirements_total, 12);
  assert.equal(result.summary.slots_placed, 12, 'every requirement placed');
  assert.equal(result.unresolved.length, 0);

  for (const s of result.slots) {
    // A class never has two things at the same day+period.
    assert.equal(result.slots.filter((x) => x.day === s.day && x.period === s.period && x.class_section === s.class_section).length, 1);
  }
  // No teacher or room appears twice in any cell (different teachers/rooms
  // can legitimately share a cell — different classes).
  for (let d = 0; d < 5; d++) {
    for (let p = 1; p <= 3; p++) {
      const cellSlots = result.slots.filter((s) => s.day === d && s.period === p);
      assert.equal(new Set(cellSlots.map((s) => s.staff_id)).size, cellSlots.length, `staff double-booked at day ${d} period ${p}`);
      assert.equal(new Set(cellSlots.map((s) => s.room_id)).size, cellSlots.length, `room double-booked at day ${d} period ${p}`);
    }
  }
  // Load cap respected: 12 periods over 2 teachers with cap 9 each.
  const perTeacher = {};
  for (const s of result.slots) perTeacher[s.staff_id] = (perTeacher[s.staff_id] || 0) + 1;
  Object.values(perTeacher).forEach((n) => assert.ok(n <= 9, `teacher over load cap: ${n}`));
});

test('generated output passes the real conflict detector (belt-and-braces)', () => {
  const result = generateTimetable({
    rooms: rooms(3),
    staff: staff(3),
    requirements: [
      { class_section: '9A', subject: 'Maths', periods_per_week: 4, room_type: 'classroom' },
      { class_section: '9B', subject: 'Science', periods_per_week: 4, room_type: 'classroom' },
      { class_section: '10A', subject: 'English', periods_per_week: 4, room_type: 'classroom' },
      { class_section: '10B', subject: 'Maths', periods_per_week: 4, room_type: 'classroom' },
    ],
    periodsPerDay: 4,
    daysPerWeek: 5,
  });

  const db = makeDb();
  // Seed the same staff/rooms the generator was given (FK references).
  for (const r of rooms(3)) db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES (?, 30, ?)`).run(r.name, r.room_type);
  for (const s of staff(3)) db.prepare(`INSERT INTO staff (name, subject) VALUES (?, ?)`).run(s.name, 'Subj');
  insertGenerated(db, result.slots);
  const flagged = scanAllConflicts(db);
  assert.equal(flagged.length, 0, 'the real conflict detector must find zero clashes in generated output');
  db.close();
});

test('lab subjects only use lab rooms', () => {
  const result = generateTimetable({
    rooms: [
      { id: 1, name: 'Rm 1', room_type: 'classroom' },
      { id: 2, name: 'Lab 1', room_type: 'lab' },
    ],
    staff: [
      { id: 1, name: 'T1', subjects: ['Chemistry'], max_periods_per_week: 10 },
    ],
    requirements: [
      { class_section: '10A', subject: 'Chemistry', periods_per_week: 2, room_type: 'lab' },
    ],
    periodsPerDay: 5,
    daysPerWeek: 5,
  });
  assert.equal(result.summary.slots_placed, 2);
  for (const s of result.slots) assert.equal(s.room_id, 2, 'lab requirement must land in the lab room');
});

test('impossible scenario returns unresolved instead of crashing or silently dropping', () => {
  // 3 classes × 5 periods/week of Maths, but only 1 teacher with cap 9 and 1 room.
  const result = generateTimetable({
    rooms: rooms(1),
    staff: [{ id: 1, name: 'T1', subjects: ['Maths'], max_periods_per_week: 9 }],
    requirements: [
      { class_section: '9A', subject: 'Maths', periods_per_week: 5, room_type: 'classroom' },
      { class_section: '9B', subject: 'Maths', periods_per_week: 5, room_type: 'classroom' },
      { class_section: '10A', subject: 'Maths', periods_per_week: 5, room_type: 'classroom' },
    ],
    periodsPerDay: 3,
    daysPerWeek: 5,
  });
  assert.equal(result.summary.slots_placed, 9, 'teacher cap limits placement to 9');
  assert.ok(result.unresolved.length > 0, 'the remaining 6 requirements are reported, not dropped');
  assert.equal(result.unresolved.length + result.summary.slots_placed, 15);
});

test('a subject nobody teaches is reported as a staffing gap, rest still solves', () => {
  const result = generateTimetable({
    rooms: rooms(2),
    staff: [{ id: 1, name: 'T1', subjects: ['Maths'], max_periods_per_week: 10 }],
    requirements: [
      { class_section: '9A', subject: 'Maths', periods_per_week: 3, room_type: 'classroom' },
      { class_section: '9A', subject: 'Social Studies', periods_per_week: 2, room_type: 'classroom' },
    ],
    periodsPerDay: 3,
    daysPerWeek: 5,
  });
  assert.equal(result.summary.slots_placed, 3);
  assert.equal(result.unresolved.length, 2, 'both Social Studies periods flagged');
  assert.equal(result.unresolved[0].subject, 'Social Studies');
  assert.match(result.unresolved[0].reason, /no qualified teacher/);
});

test('empty inputs produce an honest empty result, no crash', () => {
  const result = generateTimetable({ rooms: [], staff: [], requirements: [], periodsPerDay: 6, daysPerWeek: 5 });
  assert.deepEqual(result.slots, []);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.summary.slots_placed, 0);
});
