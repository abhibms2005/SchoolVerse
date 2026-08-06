'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers');
const { predictStaffing } = require('../src/staffing-predictor');

// Seed a compact world: one class, one teacher, one room, one timetable slot
// on a Tuesday (day 1), and attendance history where that class is frequently
// absent on Tuesdays.
function seedWorld(db) {
  db.prepare(`INSERT INTO students (name, class) VALUES ('A1', '9A'), ('A2', '9A'), ('B1', '9B')`).run();
  db.prepare(`INSERT INTO staff (name, subject) VALUES ('T1', 'Maths')`).run();
  db.prepare(`INSERT INTO rooms (name, capacity) VALUES ('Rm 1', 30)`).run();
  db.prepare(`INSERT INTO classes (name) VALUES ('9A'), ('9B')`).run();
  db.prepare(`INSERT INTO subjects (name) VALUES ('Maths'), ('Social Studies')`).run();
  // 9A needs Maths (taught) and Social Studies (nobody qualified → structural gap).
  db.prepare(`INSERT INTO class_subject_requirements (class_id, subject_id, periods_per_week, room_type) VALUES (1, 1, 4, 'classroom'), (1, 2, 2, 'classroom')`).run();
  db.prepare(`INSERT INTO staff_subjects (staff_id, subject_id, max_periods_per_week) VALUES (1, 1, 25)`).run();
  // Timetable: 9A Maths on Tuesday P2 (day 1, period 2).
  db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (1, 2, 'Maths', 1, 1, '9A')`).run();
}

// 2026-08-04/11/18 are Tuesdays (strftime %w = 2 → day 1); 03/10/17 Mondays.
const TUESDAYS = ['2026-08-04', '2026-08-11', '2026-08-18'];
const MONDAYS = ['2026-08-03', '2026-08-10', '2026-08-17'];

test('predicts shortfall from real historical absence on the slot weekday', () => {
  const db = makeDb();
  seedWorld(db);
  // 9A's two students: both absent every Tuesday (6-record sample, passes the
  // minimum-sample guard), both present every Monday.
  const att = db.prepare(`INSERT INTO attendance_records (student_id, date, status) VALUES (?, ?, ?)`);
  for (const date of TUESDAYS) { att.run(1, date, 'absent'); att.run(2, date, 'absent'); }
  for (const date of MONDAYS) { att.run(1, date, 'present'); att.run(2, date, 'present'); }

  const predictions = predictStaffing(db, 10);
  const maths = predictions.find((p) => p.subject === 'Maths');
  assert.ok(maths, 'a Maths prediction exists');
  assert.equal(maths.day, 1);
  assert.equal(maths.period, 2);
  assert.equal(maths.class_section, '9A');
  assert.equal(maths.predicted_shortfall, 2, 'both 9A students historically absent that weekday');
  assert.match(maths.reason, /100\.0%/);
});

test('tiny samples are ignored — no prediction from a single record', () => {
  const db = makeDb();
  seedWorld(db);
  // Only ONE absence record exists for the class-weekday bucket — below the
  // minimum-sample guard, so no statistically meaningless 100% projection.
  db.prepare(`INSERT INTO attendance_records (student_id, date, status) VALUES (1, '2026-08-04', 'absent')`).run();

  const predictions = predictStaffing(db, 10);
  assert.ok(!predictions.some((p) => p.subject === 'Maths'), 'a 1-record bucket must not produce a prediction');
});

test('structural gap (no qualified teacher) is surfaced with the class size', () => {
  const db = makeDb();
  seedWorld(db);

  const predictions = predictStaffing(db, 10);
  const gap = predictions.find((p) => p.subject === 'Social Studies');
  assert.ok(gap, 'the unqualified subject appears');
  assert.equal(gap.class_section, '9A');
  assert.equal(gap.predicted_shortfall, 2, 'shortfall = active class size');
  assert.equal(gap.day, null, 'structural gaps have no day/period');
  assert.match(gap.reason, /no teacher is qualified/);
});

test('no history → only structural gaps, no fabricated absence numbers', () => {
  const db = makeDb();
  seedWorld(db); // attendance_records empty

  const predictions = predictStaffing(db, 10);
  assert.ok(predictions.every((p) => p.subject === 'Social Studies'), 'absence-based predictions require real records');
  assert.ok(!predictions.some((p) => p.subject === 'Maths'), 'Maths has no history so no prediction');
});

test('empty database returns an honest empty list', () => {
  const db = makeDb();
  assert.deepEqual(predictStaffing(db, 10), []);
  db.close();
});
