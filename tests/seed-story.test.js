'use strict';
// Day-6 demo-story test: the dev seed must produce a deliberate, curated
// first-load queue — one clash, one low-confidence review, one overdue fee,
// one staffing gap, one actionable staffing suggestion, one absence alert —
// and never statistically meaningless noise ("100% from 1 record").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers');
const { seedDemo } = require('../db/seeds/dev-seed');

function seed() {
  // seedDemo is destructive and needs the admin credentials it refuses to
  // hardcode — supply them for the test.
  process.env.SEED_ADMIN_EMAIL = 'admin@demo.test';
  process.env.SEED_ADMIN_PASSWORD = 'demo-pass';
  try {
    const db = makeDb();
    seedDemo(db);
    return db;
  } finally {
    delete process.env.SEED_ADMIN_EMAIL;
    delete process.env.SEED_ADMIN_PASSWORD;
  }
}

function openNotifications(db) {
  return db.prepare(`SELECT * FROM notifications WHERE resolved = 0`).all();
}

test('the seed tells the full curated story on first load', () => {
  const db = seed();
  const items = openNotifications(db);
  const types = items.reduce((m, n) => ((m[n.type] = (m[n.type] || 0) + 1), m), {});

  // Exactly one of each story element — no flood, no duplicates.
  assert.equal(types.clash, 2, 'the one room clash flags both slots');
  assert.equal(types.absence, 1, 'one consecutive-absence alert (Isha)');
  assert.equal(types.fee_overdue, 1, 'one overdue fee (Rohan)');
  assert.equal(types.staffing_gap, 1, 'one staffing gap (9A Social Studies)');
  assert.equal(types.staffing_suggestion, 2, '10A Monday gap → one actionable + one honest no-candidate');
  assert.equal(types.pending_review, 3, 'one row per pending form — no low-conf duplicate');

  // The actionable suggestion names a real replacement teacher; the other
  // row degrades gracefully (no qualified teacher free) per the Day-3
  // contract. Both come from the same real 10A Monday absence signal.
  const suggestions = items.filter((n) => n.type === 'staffing_suggestion');
  const actionable = suggestions.find((n) => n.staff_id);
  const noCandidate = suggestions.find((n) => !n.staff_id);
  assert.ok(actionable, 'an actionable suggestion exists');
  assert.match(actionable.message, /Suggest J\. Menon/);
  assert.ok(noCandidate, 'a no-candidate row exists');
  assert.match(noCandidate.message, /no qualified teacher is free at this slot/);

  // The low-confidence form surfaces with its reason — exactly once.
  const kabirRows = items.filter((n) => n.type === 'pending_review' && /Kabir/.test(n.message));
  assert.equal(kabirRows.length, 1, 'Kabir appears once, not as a duplicate');
  assert.match(kabirRows[0].message, /low OCR confidence \(55%\)/);

  // The absence alert names Isha and says 3 days.
  const absence = items.find((n) => n.type === 'absence');
  assert.match(absence.message, /Isha Patel/);
  assert.match(absence.message, /3 consecutive days/);

  db.close();
});

test('no staffing projection ever comes from a 1-record sample', () => {
  const db = seed();
  const items = openNotifications(db);
  for (const n of items) {
    assert.ok(!/\(1\/1 records\)/.test(n.message), `no 1-record projection: ${n.message}`);
  }
  db.close();
});

test('the seed student spread is realistic and predictor-friendly', () => {
  const db = seed();
  const counts = db.prepare(`SELECT class, COUNT(*) c FROM students GROUP BY class ORDER BY class`).all();
  for (const row of counts) {
    assert.ok(row.c >= 3, `class ${row.class} has ≥3 students (got ${row.c})`);
  }
  // 14-day matrix: every student has one attendance row per day.
  const perStudent = db.prepare(
    `SELECT student_id, COUNT(*) c FROM attendance_records GROUP BY student_id ORDER BY c LIMIT 1`
  ).get();
  assert.equal(perStudent.c, 14, 'two full weeks of history per student');
  db.close();
});
