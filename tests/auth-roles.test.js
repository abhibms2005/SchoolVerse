'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeDb, mountRouter } = require('./helpers');
const { requireRole, verify, hashPassword } = require('../src/auth');
const authRouter = require('../routes/auth');
const teacherRouter = require('../routes/teacher');

/* ---------- requireRole middleware ---------- */
test('requireRole rejects a teacher session on an admin-only route (403, clean JSON)', async () => {
  const router = express.Router();
  router.get('/secret', requireRole('admin'), (req, res) => res.json({ ok: true }));
  const { base, close } = await mountRouter(router, '/api', { email: 't@school', role: 'teacher' });
  try {
    const res = await fetch(`${base}/api/secret`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /admin/);
  } finally { await close(); }
});

test('requireRole lets an admin through', async () => {
  const router = express.Router();
  router.get('/secret', requireRole('admin'), (req, res) => res.json({ ok: true }));
  const { base, close } = await mountRouter(router, '/api', { email: 'a@school', role: 'admin' });
  try {
    const res = await fetch(`${base}/api/secret`);
    assert.equal(res.status, 200);
  } finally { await close(); }
});

test('a session with no role is rejected cleanly (403, not a 500)', async () => {
  const router = express.Router();
  router.get('/secret', requireRole('admin'), (req, res) => res.json({ ok: true }));
  // Legacy/tampered session: signed but role-less.
  const { base, close } = await mountRouter(router, '/api', { email: 'old@school' });
  try {
    const res = await fetch(`${base}/api/secret`);
    assert.equal(res.status, 403);
  } finally { await close(); }
});

/* ---------- teacher scope: timetable ---------- */
function seedTeacherWorld(db) {
  const stA = db.prepare(`INSERT INTO staff (name, subject) VALUES ('A. Alpha', 'Physics')`).run().lastInsertRowid;
  const stB = db.prepare(`INSERT INTO staff (name, subject) VALUES ('B. Beta', 'Maths')`).run().lastInsertRowid;
  const s1 = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('S1', '10A', 'A', 'active')`).run().lastInsertRowid;
  const s2 = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('S2', '10B', 'B', 'active')`).run().lastInsertRowid;
  const s3 = db.prepare(`INSERT INTO students (name, class, section, status) VALUES ('S3', '9A', 'A', 'active')`).run().lastInsertRowid;
  const room = db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES ('Rm 1', 40, 'classroom')`).run().lastInsertRowid;
  // Alpha teaches 10A + 9A; Beta teaches 10B.
  const ins = db.prepare(`INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section) VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run(0, 1, 'Physics', stA, room, '10A');
  ins.run(0, 2, 'Science', stA, room, '9A');
  ins.run(0, 3, 'Maths', stB, room, '10B');
  return { stA, stB, s1, s2, s3, room };
}

// The scope must come from the session's staff_id, so test it in one mount.
test('teacher timetable returns only their staff row’s slots', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    seedTeacherWorld(h.db);
    const res = await fetch(`${h.base}/api/teacher/timetable`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.slots.length, 2); // Alpha teaches 10A + 9A
    assert.ok(body.slots.every((s) => s.staff_id === 1));
    assert.deepStrictEqual(body.classes.sort(), ['10A', '9A']);
  } finally { await h.close(); }
});

test('teacher account with no staff link returns a clean 400', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'x@school', role: 'teacher', staff_id: null });
  try {
    const res = await fetch(`${h.base}/api/teacher/timetable`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /staff record/);
  } finally { await h.close(); }
});

/* ---------- teacher scope: attendance ---------- */
test('teacher attendance lists only students in their classes', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s1, s3 } = seedTeacherWorld(h.db);
    h.db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-05', 'present', 'RFID')`).run(s1);
    h.db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, '2026-01-05', 'absent', 'RFID')`).run(s3);
    const res = await fetch(`${h.base}/api/teacher/attendance?days=30`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const names = body.students.map((s) => s.name);
    assert.ok(names.includes('S1') && names.includes('S3'));
    assert.ok(!names.includes('S2')); // 10B belongs to Beta
  } finally { await h.close(); }
});

test('teacher can correct attendance for their own student (upsert, method manual)', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s1 } = seedTeacherWorld(h.db);
    const res = await fetch(`${h.base}/api/teacher/attendance/${s1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-10', status: 'absent' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attendance.status, 'absent');
    assert.equal(body.attendance.method, 'manual');
    // Upsert: patching the same day updates the single row, no duplicate.
    await fetch(`${h.base}/api/teacher/attendance/${s1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-10', status: 'present' }),
    });
    const rows = h.db.prepare(`SELECT COUNT(*) c FROM attendance_records WHERE student_id = ? AND date = '2026-02-10'`).get(s1).c;
    assert.equal(rows, 1);
    assert.equal(h.db.prepare(`SELECT status FROM attendance_records WHERE student_id = ? AND date = '2026-02-10'`).get(s1).status, 'present');
  } finally { await h.close(); }
});

test('teacher CANNOT correct a student in another teacher’s class (403)', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s2 } = seedTeacherWorld(h.db); // 10B — Beta's class
    const res = await fetch(`${h.base}/api/teacher/attendance/${s2}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-10', status: 'present' }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /not in a class you teach/);
  } finally { await h.close(); }
});

test('teacher attendance correction validates status/date (400, no crash)', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s1 } = seedTeacherWorld(h.db);
    const bad1 = await fetch(`${h.base}/api/teacher/attendance/${s1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-10', status: 'banana' }),
    });
    assert.equal(bad1.status, 400);
    const bad2 = await fetch(`${h.base}/api/teacher/attendance/${s1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: 'not-a-date', status: 'present' }),
    });
    assert.equal(bad2.status, 400);
    const unknown = await fetch(`${h.base}/api/teacher/attendance/999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-02-10', status: 'present' }),
    });
    assert.equal(unknown.status, 404);
  } finally { await h.close(); }
});

/* ---------- teacher scope: notifications ---------- */
test('teacher notifications include only their students’ items', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s1, s2 } = seedTeacherWorld(h.db);
    h.db.prepare(`INSERT INTO uploaded_forms (student_id, form_type, file_path, status) VALUES (?, 'admission', 'uploads/x.pdf', 'pending_review')`).run(s1);
    h.db.prepare(`INSERT INTO uploaded_forms (student_id, form_type, file_path, status) VALUES (?, 'admission', 'uploads/y.pdf', 'pending_review')`).run(s2); // not Alpha's
    h.db.prepare(`INSERT INTO notifications (type, message, severity, resolved, fingerprint, student_id) VALUES ('absence', 'alert for S1', 'warning', 0, 'absence_1', ?)`).run(s1);
    h.db.prepare(`INSERT INTO notifications (type, message, severity, resolved, fingerprint, student_id) VALUES ('absence', 'alert for S2', 'warning', 0, 'absence_2', ?)`).run(s2); // not Alpha's
    const res = await fetch(`${h.base}/api/teacher/notifications`);
    assert.equal(res.status, 200);
    const items = (await res.json()).notifications;
    assert.equal(items.length, 2); // S1 form + S1 absence; S2's two items excluded
    assert.ok(items.every((n) => !/S2/.test(n.message)));
  } finally { await h.close(); }
});

test('teacher sees the real low-confidence review reason, not a generic synthesized message', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'teacher', staff_id: 1 });
  try {
    const { s1 } = seedTeacherWorld(h.db);
    // The notification service writes a low-conf row WITH student_id; the
    // teacher's queue must surface that exact row (message + reason).
    const formId = h.db.prepare(
      `INSERT INTO uploaded_forms (student_id, form_type, file_path, extracted_data, extraction_status, extraction_confidence, status)
       VALUES (?, 'medical', 'uploads/x.pdf', ?, 'done', 0.55, 'pending_review')`
    ).run(s1, JSON.stringify({ form_type: 'medical', confidence: 0.55, needs_human_review: true })).lastInsertRowid;
    // Fingerprint is built in JS (like upsertNotification does) — SQL `||`
    // would render the number as '1.0' and break the dedupe regex.
    h.db.prepare(
      `INSERT INTO notifications (type, message, severity, resolved, fingerprint, student_id)
       VALUES ('pending_review', 'medical form for S1 needs manual review — low OCR confidence (55%)', 'warning', 0, ?, ?)`
    ).run(`low_conf_form_${formId}`, s1);
    const res = await fetch(`${h.base}/api/teacher/notifications`);
    assert.equal(res.status, 200);
    const items = (await res.json()).notifications;
    const lowConf = items.find((n) => /medical form for S1/.test(n.message));
    assert.ok(lowConf, 'the low-confidence form appears for the teacher');
    assert.match(lowConf.message, /low OCR confidence \(55%\)/);
    assert.ok(!items.some((n) => /medical form for S1 awaits review/.test(n.message)), 'no duplicate generic row when the real one exists');
  } finally { await h.close(); }
});

// Login must use the router's own db, so build a tiny server around authRouter
// with our seeded db instead of mountRouter's fresh one.
test('login issues a role-carrying session cookie', async () => {
  const express = require('express');
  const db = makeDb();
  db.prepare(`INSERT INTO admins (email, password_hash, role) VALUES ('admin@school.org', ?, 'admin')`).run(hashPassword('pw1'));
  db.prepare(`INSERT INTO admins (email, password_hash, role) VALUES ('teach@school.org', ?, 'teacher')`).run(hashPassword('pw2'));
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', authRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'teach@school.org', password: 'pw2' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, 'teacher');
    // undici exposes Set-Cookie via getSetCookie(), not headers.get().
    const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie');
    const cookie = setCookie.split(';')[0];
    const token = cookie.split('=')[1];
    const session = verify(token); // decode the signed payload directly
    assert.equal(session.role, 'teacher');
    assert.equal(session.email, 'teach@school.org');
  } finally { await new Promise((r) => server.close(r)); }
});

// Mirror server.js's mount order exactly: teacher routes mount BEFORE the
// admin-only gate, so a teacher reaches /api/teacher/* but gets a clean 403
// on every admin surface (roster, payments, forms, timetable writes…).
test('server mount order: teacher gets 403 on admin routes, 200 on teacher routes', async () => {
  const app = express();
  const db = makeDb();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  // The real server.js requires a signed session; here we inject the role
  // directly (the same payload requireAuth would verify) to isolate the gate.
  app.use('/api', (req, res, next) => { req.admin = { email: 't@school', role: 'teacher', staff_id: 1 }; next(); });
  app.use('/api/teacher', requireRole('teacher', 'admin'), require('../routes/teacher'));
  app.use('/api', requireRole('admin'));
  app.use('/api/roster', require('../routes/roster'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Teacher scoped route: 200 (staff linked).
    db.prepare(`INSERT INTO staff (name, subject, status) VALUES ('A. Alpha', 'Physics', 'active')`).run();
    const teacher = await fetch(`${base}/api/teacher/timetable`);
    assert.equal(teacher.status, 200);
    // Admin-only surface: clean 403, not a 500.
    const roster = await fetch(`${base}/api/roster/students`);
    assert.equal(roster.status, 403);
    const body = await roster.json();
    assert.match(body.error, /admin/);
  } finally { await new Promise((r) => server.close(r)); }
});

test('role-scoped admin access is retained: admin can mount teacher view data', async () => {
  const h = await mountRouter(teacherRouter, '/api/teacher', { email: 'a@school', role: 'admin', staff_id: 1 });
  try {
    seedTeacherWorld(h.db);
    const res = await fetch(`${h.base}/api/teacher/timetable`);
    assert.equal(res.status, 200);
  } finally { await h.close(); }
});
