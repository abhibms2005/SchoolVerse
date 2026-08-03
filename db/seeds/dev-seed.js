'use strict';
// Dev seed data — populates realistic sample rows so the app has something to
// show locally (and, via seedIfEmpty, on an empty production database).
//
// The destructive wipe-and-reseed behaviour is dev-only: running this file
// directly refuses when NODE_ENV=production. The exported seedIfEmpty() is
// the production-safe path — it seeds ONLY when the admins table is empty,
// and never wipes existing rows.
const { openDb, DB_PATH } = require('../../src/db');
const { migrate } = require('../migrate');
const { hashPassword } = require('../../src/auth');

function seedDemo(db) {
  /* ---------- admin credentials (required env vars — no hardcoded default) ---------- */
  // Validate BEFORE any destructive work: a misconfigured seed must fail as a
  // clean no-op, not wipe the database and then throw part-way through.
  const ADMIN_EMAIL = String(process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
  const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || '';
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('[seed] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set — no default admin credentials are committed.');
  }

  // Wipe existing rows so re-seeding is deterministic (dev-only behaviour).
  for (const table of [
    'notifications', 'uploaded_forms', 'attendance_records',
    'timetable_slots', 'admins', 'rooms', 'staff', 'students',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('notifications','uploaded_forms','attendance_records','timetable_slots','admins','rooms','staff','students')`).run();

  /* ---------- rooms ---------- */
  const rooms = ['Rm 2', 'Rm 4', 'Rm 6', 'Rm 7', 'Lab 2', 'Lab 3', 'Lab 4', 'Hall']
    .map((name, i) => db.prepare(`INSERT INTO rooms (name, capacity) VALUES (?, ?)`)
      .run(name, [40, 40, 35, 35, 30, 30, 30, 120][i]).lastInsertRowid);

  /* ---------- staff ---------- */
  const staff = [
    ['R. Iyer',   'Physics'],
    ['S. Das',    'Maths'],
    ['P. Mehta',  'English'],
    ['A. Rao',    'Chemistry'],
    ['K. Sharma', 'Hindi'],
    ['V. Nair',   'Science'],
  ].map(([name, subject]) => db.prepare(`INSERT INTO staff (name, subject, contact) VALUES (?, ?, ?)`)
    .run(name, subject, 'not listed').lastInsertRowid);
  const [IYER, DAS, MEHTA, RAO, SHARMA, NAIR] = staff;

  /* ---------- students ---------- */
  const students = [
    ['Aarav Sharma', '9B',  'A', '+91 98100 11111'],
    ['Diya Kapoor',  '10A', 'A', '+91 98100 22222'],
    ['Rohan Verma',  '10B', 'B', '+91 98100 33333'],
    ['Isha Patel',   '9A',  'A', '+91 98100 44444'],
    ['Kabir Singh',  '10A', 'B', '+91 98100 55555'],
    ['Meera Iyer',   '9B',  'B', '+91 98100 66666'],
  ].map(([name, cls, section, contact]) => db.prepare(
    `INSERT INTO students (name, class, section, guardian_contact, admission_date, status)
     VALUES (?, ?, ?, ?, date('now', '-3 months'), 'active')`)
    .run(name, cls, section, contact).lastInsertRowid);

  /* ---------- timetable slots ----------
     Day: 0=Mon … 4=Fri. Periods 1..6.
     Deliberately seeded conflicts:
     - Tue P4 (day 1, period 4): 10A Physics (Iyer) and 10B Chemistry (Rao) BOTH in Lab 3 → room clash.
     - Wed P4 (day 2, period 4): 10B Chemistry auto-rebooked to Lab 4 (resolved_from_conflict = 1).
     - Mon P5 (day 0, period 5): 9A Social Studies has NO teacher → staffing gap. */
  const slot = db.prepare(`INSERT INTO timetable_slots
    (day, period, subject, staff_id, room_id, class_section, conflict, conflict_reason, resolved_from_conflict)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, 0)`);
  const slotResolved = db.prepare(`INSERT INTO timetable_slots
    (day, period, subject, staff_id, room_id, class_section, conflict, conflict_reason, resolved_from_conflict)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'Room double-booked', 1)`);

  // Mon
  slot.run(0, 1, 'Maths',     DAS,   rooms[1], '10A');     // Rm 4
  slot.run(0, 2, 'Physics',   IYER,  rooms[4], '10A');     // Lab 2
  slot.run(0, 3, 'Chemistry', RAO,   rooms[5], '10B');     // Lab 3
  slot.run(0, 4, 'English',   MEHTA, rooms[3], '9B');      // Rm 7
  slot.run(0, 5, 'Social Studies', null, rooms[0], '9A');  // staffing gap: no teacher
  slot.run(0, 6, 'Hindi',     SHARMA, rooms[0], '9A');     // Rm 2
  // Tue
  slot.run(1, 1, 'English',  MEHTA,  rooms[3], '9B');      // Rm 7
  slot.run(1, 2, 'Physics',  IYER,   rooms[4], '10A');     // Lab 2
  slot.run(1, 3, 'Maths',    DAS,    rooms[1], '9A');      // Rm 4
  slot.run(1, 4, 'Physics',  IYER,   rooms[5], '10A');     // Lab 3  ← CLASH A
  slot.run(1, 4, 'Chemistry', RAO,   rooms[5], '10B');     // Lab 3  ← CLASH B
  slot.run(1, 5, 'Science',  NAIR,   rooms[6], '9A');      // Rm 6
  slot.run(1, 6, 'Maths',    DAS,    rooms[1], '10B');     // Rm 4
  // Wed
  slot.run(2, 1, 'Physics',  IYER,  rooms[4], '10B');      // Lab 2
  slot.run(2, 2, 'Hindi',    SHARMA, rooms[0], '9A');      // Rm 2
  slot.run(2, 3, 'Maths',    DAS,    rooms[1], '9A');      // Rm 4
  slotResolved.run(2, 4, 'Chemistry', RAO, rooms[6], '10B'); // Lab 4 — AUTO-RESOLVED ✓
  slot.run(2, 5, 'Chemistry', RAO,   rooms[5], '10A');     // Lab 3
  slot.run(2, 6, 'English',  MEHTA,  rooms[3], '9B');      // Rm 7
  // Thu
  slot.run(3, 1, 'Science', NAIR,   rooms[2], '9A');       // Rm 6
  slot.run(3, 2, 'Chemistry', RAO,  rooms[5], '10B');      // Lab 3
  slot.run(3, 3, 'English', MEHTA,  rooms[3], '9B');       // Rm 7
  slot.run(3, 4, 'Maths',   DAS,    rooms[1], '9A');       // Rm 4
  slot.run(3, 5, 'English', MEHTA,  rooms[3], '10A');      // Rm 7
  slot.run(3, 6, 'Science', NAIR,   rooms[2], '10B');      // Rm 6
  // Fri
  slot.run(4, 1, 'English', MEHTA,  rooms[3], '9A');       // Rm 7
  slot.run(4, 2, 'Maths',   DAS,    rooms[1], '10B');      // Rm 4
  slot.run(4, 3, 'Maths',   DAS,    rooms[1], '9B');       // Rm 4
  slot.run(4, 4, 'Physics', IYER,   rooms[4], '9B');       // Lab 2
  slot.run(4, 5, 'Hindi',   SHARMA, rooms[0], '9B');       // Rm 2
  slot.run(4, 6, 'Science', NAIR,   rooms[2], '10A');      // Rm 6

  /* ---------- attendance (last 5 school days, mixed methods) ---------- */
  const att = db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, ?, ?, ?)`);
  const methods = ['RFID', 'RFID', 'CV', 'manual'];
  for (let d = 5; d >= 1; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    students.forEach((sid, i) => {
      const absent = (i === d % students.length);          // rotate one absentee per day
      att.run(sid, date, absent ? 'absent' : 'present', methods[i % methods.length]);
    });
  }

  /* ---------- uploaded forms ---------- */
  const forms = [
    { student: students[0], type: 'admission', status: 'pending_review',
      data: JSON.stringify({ name: 'Aarav Sharma', class: '9B', guardian: '+91 98100 11111', fee_paid: true, confidence: 0.87, fields_needing_review: [4, 7] }) },
    { student: students[2], type: 'fee_receipt', status: 'pending_review',
      data: JSON.stringify({ name: 'Rohan Verma', amount: 42500, paid: true, confidence: 0.92, fields_needing_review: [2] }) },
    { student: students[4], type: 'medical', status: 'pending_review',
      data: JSON.stringify({ name: 'Kabir Singh', condition: 'Asthma', confidence: 0.71, fields_needing_review: [1, 3] }) },
    { student: students[1], type: 'admission', status: 'verified',
      data: JSON.stringify({ name: 'Diya Kapoor', class: '10A', guardian: '+91 98100 22222', fee_paid: true, confidence: 0.95, fields_needing_review: [] }) },
  ];
  const form = db.prepare(`INSERT INTO uploaded_forms (student_id, form_type, file_path, extracted_data, status)
    VALUES (?, ?, ?, ?, ?)`);
  const formIds = forms.map((f) => form.run(f.student, f.type, `uploads/seed-${f.type.replace('_', '-')}.pdf`, f.data, f.status).lastInsertRowid);

  /* ---------- admin ---------- */
  db.prepare(`INSERT INTO admins (email, password_hash) VALUES (?, ?)`)
    .run(ADMIN_EMAIL, hashPassword(ADMIN_PASSWORD));

  /* ---------- generate notifications from the seeded state ---------- */
  const { runScan } = require('../../src/notification-service');
  const scanResult = runScan(db);

  console.log('┌──────────────────────────────────────────────┐');
  console.log('│  SchoolVerse dev seed loaded                 │');
  console.log(`│  DB: ${DB_PATH}`);
  console.log(`│  students: ${students.length}  staff: ${staff.length}  rooms: ${rooms.length}`);
  console.log(`│  slots: ${db.prepare('SELECT COUNT(*) c FROM timetable_slots').get().c}`);
  console.log(`│  forms: ${formIds.length} (3 pending review)  attendance: ${db.prepare('SELECT COUNT(*) c FROM attendance_records').get().c}`);
  console.log(`│  admin: ${ADMIN_EMAIL}  (password from SEED_ADMIN_PASSWORD)`);
  console.log(`│  notifications generated by scan: ${scanResult.clashes} clash flags + pending/gap items`);
  console.log('└──────────────────────────────────────────────┘');
}

/**
 * Production-safe demo seeding: populates the database ONLY when it is
 * completely fresh (no admins yet). Never wipes existing data.
 * @returns {boolean} true if the demo data was seeded
 */
function seedIfEmpty(db) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM admins').get();
  if (c > 0) return false;
  seedDemo(db);
  return true;
}

module.exports = { seedDemo, seedIfEmpty };

if (require.main === module) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[seed] refusing to run dev seed in production');
    process.exit(1);
  }
  const db = openDb();
  migrate(db);
  seedDemo(db);
  db.close();
}
