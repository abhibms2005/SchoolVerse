'use strict';
const express = require('express');

const router = express.Router();

// GET /api/roster/students (authed)
router.get('/students', (req, res) => {
  const rows = req.db.prepare(`
    SELECT id, name, class, section, guardian_contact, admission_date, status
      FROM students ORDER BY name LIMIT 200`).all();
  res.json({ students: rows });
});

// GET /api/roster/staff (authed)
router.get('/staff', (req, res) => {
  const rows = req.db.prepare(`SELECT id, name, subject, contact FROM staff ORDER BY name`).all();
  res.json({ staff: rows });
});

// GET /api/roster/rooms (authed)
router.get('/rooms', (req, res) => {
  const rows = req.db.prepare(`SELECT id, name, capacity FROM rooms ORDER BY name`).all();
  res.json({ rooms: rows });
});

module.exports = router;
