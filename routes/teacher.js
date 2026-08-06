'use strict';
// Teacher-scoped routes — the Day 1–2 multi-role surface. Mounted behind
// requireAuth + requireRole('teacher', 'admin').
// Scope derives from REAL data: a teacher account links (admins.staff_id) to
// a staff row, and "their" students are the students in the classes that row
// teaches on the timetable. No duplicated per-teacher config anywhere.
const express = require('express');
const { runScan } = require('../src/notification-service');

const router = express.Router();

// Resolve a teacher's scope from the signed session. Returns null when the
// account has no staff link (misconfigured) — every handler turns that into
// a clean 400, never a crash.
function scopeOf(db, admin) {
  const staff_id = admin && admin.staff_id ? Number(admin.staff_id) : null;
  if (!staff_id) return null;
  const staff = db.prepare(`SELECT id, name, subject FROM staff WHERE id = ? AND status = 'active'`).get(staff_id);
  if (!staff) return null;
  const classes = db.prepare(
    `SELECT DISTINCT class_section FROM timetable_slots WHERE staff_id = ?`
  ).all(staff_id).map((r) => r.class_section);
  return { staff, classes };
}

// GET /api/teacher/timetable — the teacher's own weekly grid (read-only).
router.get('/timetable', (req, res) => {
  const scope = scopeOf(req.db, req.admin);
  if (!scope) return res.status(400).json({ error: 'teacher account is not linked to an active staff record' });
  const slots = req.db.prepare(`
    SELECT ts.id, ts.day, ts.period, ts.subject, ts.class_section, ts.conflict,
           st.name AS staff_name, st.id AS staff_id,
           r.name AS room_name, r.id AS room_id
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r   ON r.id  = ts.room_id
     WHERE ts.staff_id = ?
     ORDER BY ts.day, ts.period`).all(scope.staff.id);
  res.json({ teacher: scope.staff, classes: scope.classes, slots });
});

// GET /api/teacher/attendance?days=14 — the teacher's students and their
// recent attendance (real rows from the scan endpoint + manual corrections).
router.get('/attendance', (req, res) => {
  const scope = scopeOf(req.db, req.admin);
  if (!scope) return res.status(400).json({ error: 'teacher account is not linked to an active staff record' });
  if (scope.classes.length === 0) {
    return res.json({ teacher: scope.staff, classes: [], students: [], records: [] });
  }
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 60);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const placeholders = scope.classes.map(() => '?').join(', ');
  const students = req.db.prepare(
    `SELECT id, name, class FROM students WHERE status = 'active' AND class IN (${placeholders}) ORDER BY class, name`
  ).all(...scope.classes);
  const records = req.db.prepare(
    `SELECT ar.student_id, ar.date, ar.status, ar.method, ar.room_id
       FROM attendance_records ar
       JOIN students s ON s.id = ar.student_id
      WHERE s.status = 'active' AND s.class IN (${placeholders}) AND ar.date >= ?
      ORDER BY ar.date DESC, ar.student_id`
  ).all(...scope.classes, since);

  res.json({ teacher: scope.staff, classes: scope.classes, students, records });
});

// PATCH /api/teacher/attendance/:studentId  { date, status }
// Manual correction/override — the fallback when a student forgot their
// badge. Only the student's OWN teacher (someone who teaches their class)
// may correct it; the record is written as method='manual' so the live feed
// shows it as a real human override, and a scan re-runs so absence alerts
// and other notifications reconcile immediately.
router.patch('/attendance/:studentId', (req, res) => {
  const scope = scopeOf(req.db, req.admin);
  if (!scope) return res.status(400).json({ error: 'teacher account is not linked to an active staff record' });
  if (scope.classes.length === 0) return res.status(403).json({ error: 'you do not teach any classes yet' });

  const studentId = Number(req.params.studentId);
  const student = req.db.prepare(`SELECT id, name, class FROM students WHERE id = ? AND status = 'active'`).get(studentId);
  if (!student) return res.status(404).json({ error: `unknown student_id ${studentId}` });
  if (!scope.classes.includes(student.class)) {
    return res.status(403).json({ error: `${student.name} is not in a class you teach` });
  }

  const body = req.body || {};
  const status = String(body.status || '').toLowerCase();
  if (!['present', 'absent', 'late'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: present, absent, late' });
  }
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: 'date must be a YYYY-MM-DD string' });
  }

  // Upsert: a scan row for that day gets overridden in place; otherwise a new
  // manual row is created. Either way exactly one row per student/day exists.
  const existing = req.db.prepare(`SELECT id FROM attendance_records WHERE student_id = ? AND date = ?`).get(studentId, date);
  if (existing) {
    req.db.prepare(`UPDATE attendance_records SET status = ?, method = 'manual' WHERE id = ?`)
      .run(status, existing.id);
  } else {
    req.db.prepare(`INSERT INTO attendance_records (student_id, date, status, method) VALUES (?, ?, ?, 'manual')`)
      .run(studentId, date, status);
  }
  runScan(req.db); // absence alerts + anything else reconcile right away

  const row = req.db.prepare(`SELECT * FROM attendance_records WHERE student_id = ? AND date = ?`).get(studentId, date);
  res.json({ ok: true, attendance: row, student: { id: student.id, name: student.name, class: student.class } });
});

// GET /api/teacher/notifications — alerts relevant to the teacher's own
// students only: student-linked notifications (absence alerts, etc.) plus
// forms awaiting review for those students. Read-only — resolving stays
// an admin action.
router.get('/notifications', (req, res) => {
  const scope = scopeOf(req.db, req.admin);
  if (!scope) return res.status(400).json({ error: 'teacher account is not linked to an active staff record' });
  if (scope.classes.length === 0) return res.json({ notifications: [] });

  const placeholders = scope.classes.map(() => '?').join(', ');
  const studentIds = req.db.prepare(
    `SELECT id FROM students WHERE status = 'active' AND class IN (${placeholders})`
  ).all(...scope.classes).map((r) => r.id);

  const out = [];
  if (studentIds.length) {
    const idPlaceholders = studentIds.map(() => '?').join(', ');
    const notifs = req.db.prepare(`
      SELECT n.type, n.message, n.severity, n.created_at, s.name AS student_name, s.class
        FROM notifications n
        LEFT JOIN students s ON s.id = n.student_id
       WHERE n.resolved = 0 AND n.student_id IN (${idPlaceholders})
       ORDER BY n.created_at DESC LIMIT 30`).all(...studentIds);
    out.push(...notifs);
  }

  const forms = req.db.prepare(`
    SELECT f.form_type, f.status, f.uploaded_at, s.name AS student_name, s.class
      FROM uploaded_forms f
      JOIN students s ON s.id = f.student_id
     WHERE f.status = 'pending_review' AND s.status = 'active' AND s.class IN (${placeholders})
     ORDER BY f.uploaded_at DESC LIMIT 20`).all(...scope.classes);
  for (const f of forms) {
    out.push({ type: 'pending_review', message: `${f.form_type} form for ${f.student_name} awaits review`, severity: 'warning', created_at: f.uploaded_at, student_name: f.student_name, class: f.class });
  }

  out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({ notifications: out });
});

module.exports = router;
