'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { findSlotConflicts, refreshSlotConflict, scanAllConflicts } = require('../src/conflict-detector');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  // Seed minimal staff + rooms so timetable_slots FK references are valid.
  for (let i = 1; i <= 6; i++) {
    db.prepare(`INSERT INTO staff (name, subject) VALUES (?, ?)`).run(`T${i}`, 'Subj');
    db.prepare(`INSERT INTO rooms (name, capacity) VALUES (?, 30)`).run(`Rm ${i}`);
  }
  return db;
}

const insertSlot = (db, { day, period, subject, staff_id, room_id, class_section }) =>
  db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(day, period, subject, staff_id ?? null, room_id ?? null, class_section).lastInsertRowid;

test('flags two slots sharing a staff_id at the same day+period', () => {
  const db = makeDb();
  const a = insertSlot(db, { day: 1, period: 4, subject: 'Physics', staff_id: 1, room_id: 1, class_section: '10A' });
  const b = insertSlot(db, { day: 1, period: 4, subject: 'Chemistry', staff_id: 1, room_id: 2, class_section: '10B' });
  const issues = findSlotConflicts(db, { id: a, day: 1, period: 4, staff_id: 1, room_id: 1 });
  assert.ok(issues.some((i) => i.kind === 'staff' && i.withSlotId === b));
  db.close();
});

test('flags two slots sharing a room_id at the same day+period', () => {
  const db = makeDb();
  const a = insertSlot(db, { day: 1, period: 4, subject: 'Physics', staff_id: 1, room_id: 5, class_section: '10A' });
  const b = insertSlot(db, { day: 1, period: 4, subject: 'Chemistry', staff_id: 2, room_id: 5, class_section: '10B' });
  const issues = findSlotConflicts(db, { id: a, day: 1, period: 4, staff_id: 1, room_id: 5 });
  assert.ok(issues.some((i) => i.kind === 'room' && i.withSlotId === b));
  db.close();
});

test('does not flag different rooms / different teachers at the same period', () => {
  const db = makeDb();
  const a = insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 2, room_id: 1, class_section: '10A' });
  const b = insertSlot(db, { day: 0, period: 1, subject: 'English', staff_id: 3, room_id: 2, class_section: '10B' });
  const issues = findSlotConflicts(db, { id: a, day: 0, period: 1, staff_id: 2, room_id: 1 });
  assert.deepEqual(issues, []);
  assert.deepEqual(findSlotConflicts(db, { id: b, day: 0, period: 1, staff_id: 3, room_id: 2 }), []);
  db.close();
});

test('does not flag the same slot against itself', () => {
  const db = makeDb();
  const a = insertSlot(db, { day: 2, period: 3, subject: 'Hindi', staff_id: 5, room_id: 1, class_section: '9A' });
  const issues = findSlotConflicts(db, { id: a, day: 2, period: 3, staff_id: 5, room_id: 1 });
  assert.deepEqual(issues, []);
  db.close();
});

test('refreshSlotConflict marks and later clears a room clash (resolved_from_conflict)', () => {
  const db = makeDb();
  const a = insertSlot(db, { day: 1, period: 4, subject: 'Physics', staff_id: 1, room_id: 5, class_section: '10A' });
  const b = insertSlot(db, { day: 1, period: 4, subject: 'Chemistry', staff_id: 2, room_id: 5, class_section: '10B' });

  let { issues } = refreshSlotConflict(db, a);
  assert.equal(issues.length, 1);
  let row = db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(a);
  assert.equal(row.conflict, 1);
  assert.equal(row.resolved_from_conflict, 0);

  // Reassign slot a to a free room → clash clears, flag flips off, resolved flag on.
  db.prepare(`UPDATE timetable_slots SET room_id = 6 WHERE id = ?`).run(a);
  ({ issues } = refreshSlotConflict(db, a));
  assert.equal(issues.length, 0);
  row = db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(a);
  assert.equal(row.conflict, 0);
  assert.equal(row.resolved_from_conflict, 1);
  db.close();
});

test('scanAllConflicts flags only genuinely conflicting slots', () => {
  const db = makeDb();
  insertSlot(db, { day: 1, period: 4, subject: 'Physics', staff_id: 1, room_id: 5, class_section: '10A' });
  insertSlot(db, { day: 1, period: 4, subject: 'Chemistry', staff_id: 2, room_id: 5, class_section: '10B' }); // room clash
  insertSlot(db, { day: 0, period: 1, subject: 'Maths', staff_id: 3, room_id: 1, class_section: '9A' });
  insertSlot(db, { day: 0, period: 1, subject: 'English', staff_id: 4, room_id: 2, class_section: '9B' }); // fine

  const flagged = scanAllConflicts(db);
  assert.equal(flagged.length, 2); // both halves of the room clash
  const conflicted = db.prepare(`SELECT COUNT(*) c FROM timetable_slots WHERE conflict = 1`).get().c;
  assert.equal(conflicted, 2);
  db.close();
});
