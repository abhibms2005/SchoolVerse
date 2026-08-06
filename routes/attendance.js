'use strict';
const express = require('express');

const router = express.Router();

// POST /api/attendance/scan — ingest a real attendance event from a device
// (RFID reader, CV camera, or manual desk). Session-protected like the rest
// of the dashboard; the simulated hardware client (scripts/simulate-scanner.js)
// logs in first, and a real reader can hit the same endpoint with a token.
// Body: { student_id, method: 'rfid'|'cv'|'manual', room_id?, timestamp? }
router.post('/scan', (req, res) => {
  const body = req.body || {};
  const sid = Number(body.student_id);
  if (!Number.isInteger(sid) || sid <= 0) {
    return res.status(400).json({ error: 'student_id (a positive integer) is required' });
  }
  const METHOD_MAP = { rfid: 'RFID', cv: 'CV', manual: 'manual' };
  const norm = METHOD_MAP[String(body.method || '').toLowerCase()];
  if (!norm) {
    return res.status(400).json({ error: 'method must be one of: rfid, cv, manual' });
  }

  // Active-only: soft-deleted (inactive) students/rooms can't be scanned —
  // same "active only" contract as the rest of the roster.
  const student = req.db.prepare(`SELECT id, name FROM students WHERE id = ? AND status = 'active'`).get(sid);
  if (!student) {
    return res.status(404).json({ error: `unknown student_id ${sid}` });
  }

  let room = null;
  if (body.room_id !== undefined && body.room_id !== null && body.room_id !== '') {
    const rid = Number(body.room_id);
    room = req.db.prepare(`SELECT id, name FROM rooms WHERE id = ? AND status = 'active'`).get(rid);
    if (!room) return res.status(404).json({ error: `unknown room_id ${rid}` });
  }

  let date;
  if (body.timestamp !== undefined && body.timestamp !== null && body.timestamp !== '') {
    const t = new Date(body.timestamp);
    if (Number.isNaN(t.getTime())) {
      return res.status(400).json({ error: 'timestamp must be a valid ISO date string' });
    }
    date = t.toISOString().slice(0, 10);
  } else {
    date = new Date().toISOString().slice(0, 10);
  }

  const info = req.db.prepare(
    `INSERT INTO attendance_records (student_id, date, status, method, room_id)
     VALUES (?, ?, 'present', ?, ?)`
  ).run(sid, date, norm, room ? room.id : null);

  const row = req.db.prepare(`
    SELECT ar.*, s.name AS student_name, s.class, r.name AS room_name
      FROM attendance_records ar
      JOIN students s ON s.id = ar.student_id
      LEFT JOIN rooms r ON r.id = ar.room_id
     WHERE ar.id = ?`).get(info.lastInsertRowid);

  res.status(201).json({ ok: true, attendance: row });
});

// GET /api/attendance/summary (authed) — real counts from attendance_records
router.get('/summary', (req, res) => {
  const total = req.db.prepare(`SELECT COUNT(*) c FROM attendance_records`).get().c;
  const byMethod = req.db.prepare(
    `SELECT method, COUNT(*) c FROM attendance_records GROUP BY method`
  ).all();
  const byStatus = req.db.prepare(
    `SELECT status, COUNT(*) c FROM attendance_records GROUP BY status`
  ).all();

  const latestDate = req.db.prepare(`SELECT MAX(date) m FROM attendance_records`).get().m;
  const todayRows = latestDate ? req.db.prepare(`
    SELECT ar.status, ar.method, ar.date, s.name AS student_name, s.class
      FROM attendance_records ar
      JOIN students s ON s.id = ar.student_id
     WHERE ar.date = ?
     ORDER BY s.name
     LIMIT 50`).all(latestDate) : [];

  res.json({ total, by_method: byMethod, by_status: byStatus, latest_date: latestDate, today_rows: todayRows });
});

module.exports = router;
