'use strict';
const express = require('express');

const router = express.Router();

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
