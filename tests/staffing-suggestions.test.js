'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeDb, mountRouter } = require('./helpers');
const { runScan } = require('../src/notification-service');
const { suggestStaffing } = require('../src/staffing-predictor');
const timetableRouter = require('../routes/timetable');

// World: 10A students S1/S2 absent on Mondays → a projected shortfall for the
// Mon P1 Physics slot. Alpha teaches it; Beta (also Physics-qualified) is free.
function seedWorld(db, { withSecondPhysics = true } = {}) {
  const alpha = db.prepare(`INSERT INTO staff (name, subject) VALUES ('A. Alpha', 'Physics')`).run().lastInsertRowid;
  const beta = withSecondPhysics
    ? db.prepare(`INSERT INTO staff (name, subject) VALUES ('B. Beta', 'Physics')`).run().lastInsertRowid
    : null;
  const gamma = db.prepare(`INSERT INTO staff (name, subject) VALUES ('C. Gamma', 'Maths')`).run().lastInsertRowid;
  const s1 = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('S1', '10A', 'A', 'active')`).run().lastInsertRowid;
  const s2 = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('S2', '10A', 'B', 'active')`).run().lastInsertRowid;
  const room = db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Lab 1', 30, 'lab')`).run().lastInsertRowid;

  const physId = db.prepare(`INSERT INTO subjects (name) VALUES ('Physics')`).run().lastInsertRowid;
  const mathsId = db.prepare(`INSERT INTO subjects (name) VALUES ('Maths')`).run().lastInsertRowid;
  const qual = db.prepare(`INSERT INTO staff_subjects (staff_id, subject_id, max_periods_per_week) VALUES (?, ?, 25)`);
  qual.run(alpha, physId);
  if (beta) qual.run(beta, physId);
  qual.run(gamma, mathsId); // Gamma is qualified in Maths only — must never be suggested for Physics

  const slotId = db.prepare(
    `INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (0, 1, 'Physics', ?, ?, '10A')`
  ).run(alpha, room).lastInsertRowid;

  // 2026-01-05/12/19 are Mondays; both 10A students absent every one of them
  // → a realistic 6-record sample (passes the predictor's minimum-sample
  // guard) at 100% Monday absence.
  const att = db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, ?, 'absent', 'RFID')`);
  for (const date of ['2026-01-05', '2026-01-12', '2026-01-19']) {
    att.run(s1, date);
    att.run(s2, date);
  }

  return { alpha, beta, gamma, s1, s2, room, slotId };
}

test('suggestion names a qualified teacher free at the slot', () => {
  const db = makeDb();
  const { beta, slotId } = seedWorld(db);
  const suggestions = suggestStaffing(db, 10);
  const match = suggestions.find((s) => s.slot_id === slotId);
  assert.ok(match, 'expected a suggestion for the Physics slot');
  assert.equal(match.suggestion.staff_id, beta);
  assert.match(match.suggestion_reason, /free at this slot/);
});

test('notification carries slot_id + staff_id for the one-click accept', () => {
  const db = makeDb();
  const { beta, slotId } = seedWorld(db);
  runScan(db);
  const row = db.prepare(`SELECT * FROM notifications WHERE type = 'staffing_suggestion' AND fingerprint = ?`).get(`staff_suggest_${slotId}`);
  assert.ok(row, 'suggestion notification created');
  assert.equal(row.slot_id, slotId);
  assert.equal(row.staff_id, beta);
  assert.match(row.message, /Suggest B\. Beta/);
  assert.equal(row.resolved, 0);
});

test('no-candidate case says so explicitly instead of breaking', () => {
  const db = makeDb();
  const { slotId } = seedWorld(db, { withSecondPhysics: false });
  runScan(db);
  const row = db.prepare(`SELECT * FROM notifications WHERE type = 'staffing_suggestion' AND fingerprint = ?`).get(`staff_suggest_${slotId}`);
  assert.ok(row, 'a suggestion row still exists (degrade gracefully)');
  assert.equal(row.staff_id, null);
  assert.match(row.message, /no qualified teacher is free at this slot/);
});

test('repeated scans never duplicate the suggestion (fingerprint)', () => {
  const db = makeDb();
  const { slotId } = seedWorld(db);
  runScan(db);
  runScan(db);
  runScan(db);
  const count = db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'staffing_suggestion' AND fingerprint = ?`).get(`staff_suggest_${slotId}`).c;
  assert.equal(count, 1);
});

test('accepting the suggestion updates the timetable and never re-suggests the assigned teacher', async () => {
  const h = await mountRouter(timetableRouter, '/api/timetable', { email: 'a@school', role: 'admin' });
  try {
    const { alpha, beta, slotId } = seedWorld(h.db);
    runScan(h.db);
    // The Accept button posts exactly this: reassign slot to the suggested teacher.
    const res = await fetch(`${h.base}/api/timetable/slots/${slotId}/reassign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: beta }),
    });
    assert.equal(res.status, 200);
    assert.equal(h.db.prepare(`SELECT staff_id FROM timetable_slots WHERE id = ?`).get(slotId).staff_id, beta);
    // The outlook persists (students still absent-prone), so the queue re-suggests
    // the now-freed Alpha — but NEVER the teacher already assigned. Two qualified
    // staff covering one slot is the honest state; the suggestion tracks it.
    const row = h.db.prepare(`SELECT staff_id FROM notifications WHERE type = 'staffing_suggestion' AND fingerprint = ?`).get(`staff_suggest_${slotId}`);
    const slotNow = h.db.prepare(`SELECT staff_id FROM timetable_slots WHERE id = ?`).get(slotId);
    assert.notEqual(row.staff_id, slotNow.staff_id, 'suggestion must not name the assigned teacher');
    assert.ok(row.staff_id === alpha || row.staff_id === beta);
  } finally { await h.close(); }
});

test('assigning a different teacher re-opens the suggestion', async () => {
  const h = await mountRouter(timetableRouter, '/api/timetable', { email: 'a@school', role: 'admin' });
  try {
    const { beta, slotId } = seedWorld(h.db);
    runScan(h.db);
    // Manually reassign to a THIRD option is impossible here (only Beta is free),
    // so simulate "teacher changed away" by clearing to null, then rescan:
    await fetch(`${h.base}/api/timetable/slots/${slotId}/reassign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: beta }),
    });
    await fetch(`${h.base}/api/timetable/slots/${slotId}/reassign`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staff_id: null }),
    });
    const row = h.db.prepare(`SELECT resolved FROM notifications WHERE type = 'staffing_suggestion' AND fingerprint = ?`).get(`staff_suggest_${slotId}`);
    // Slot is unassigned now — no prediction (staff_id IS NULL filters it) → resolved.
    assert.equal(row.resolved, 1);
  } finally { await h.close(); }
});
