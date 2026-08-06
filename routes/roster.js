'use strict';
const express = require('express');

const router = express.Router();

// All roster reads (authed). By default only ACTIVE rows are returned so
// consumers (attendance scanner, form student dropdown, timetable inputs)
// never see soft-deleted entries. The data hub passes include_inactive=1 to
// show everything — including a Restore action.
function activeWhere(req) {
  return req.query.include_inactive === '1' || req.query.include_inactive === 'true' ? '' : `status = 'active'`;
}

/* ---------- validation helpers ---------- */
function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label} is required`;
  return null;
}

// Optional free-text fields: must be a string when provided (an object/array
// would make better-sqlite3 throw on bind → ugly 500 instead of a clean 400).
function optString(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'must be a string when provided';
  return null;
}

// Strict positive integer: plain JS number or digit-only string. Rejects
// booleans, '0x10', '1e21', floats, and empty input.
function validPositiveInt(v) {
  if (typeof v === 'boolean' || v === null || v === '' || v === undefined) return false;
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) return false;
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

const STUDENT_STATUSES = ['active', 'inactive', 'left'];
const STAFF_ROOM_STATUSES = ['active', 'inactive'];

/* ================= students ================= */

// GET /api/roster/students?include_inactive=1
router.get('/students', (req, res) => {
  const where = activeWhere(req);
  const rows = req.db.prepare(
    `SELECT id, name, class, section, guardian_contact, admission_date, status
       FROM students ${where ? 'WHERE ' + where : ''} ORDER BY name LIMIT 200`
  ).all();
  res.json({ students: rows });
});

// POST /api/roster/students { name, class, section?, guardian_contact?, status? }
router.post('/students', (req, res) => {
  const { name, class: cls, section, guardian_contact, status } = req.body || {};
  const err = nonEmpty(name, 'name') || nonEmpty(cls, 'class');
  if (err) return res.status(400).json({ error: err });
  if (status !== undefined && !STUDENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STUDENT_STATUSES.join(', ')}` });
  }
  const info = req.db.prepare(
    `INSERT INTO students (name, class, section, guardian_contact, status)
     VALUES (?, ?, ?, ?, ?)`
  ).run(name.trim(), cls.trim(), section || '', guardian_contact || null, status || 'active');
  const row = req.db.prepare(`SELECT * FROM students WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, student: row });
});

// PATCH /api/roster/students/:id — partial update
router.patch('/students/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT * FROM students WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'student not found' });

  const { name, class: cls, section, guardian_contact, status } = req.body || {};
  if (name !== undefined && nonEmpty(name, 'name')) return res.status(400).json({ error: nonEmpty(name, 'name') });
  if (cls !== undefined && nonEmpty(cls, 'class')) return res.status(400).json({ error: nonEmpty(cls, 'class') });
  if (section !== undefined && optString(section)) return res.status(400).json({ error: 'section ' + optString(section) });
  if (guardian_contact !== undefined && optString(guardian_contact)) return res.status(400).json({ error: 'guardian_contact ' + optString(guardian_contact) });
  if (status !== undefined && !STUDENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STUDENT_STATUSES.join(', ')}` });
  }
  req.db.prepare(
    `UPDATE students SET
       name = COALESCE(?, name), class = COALESCE(?, class),
       section = COALESCE(?, section), guardian_contact = COALESCE(?, guardian_contact),
       status = COALESCE(?, status)
     WHERE id = ?`
  ).run(name === undefined ? null : name.trim(), cls === undefined ? null : cls.trim(),
        section === undefined ? null : section, guardian_contact === undefined ? null : guardian_contact,
        status === undefined ? null : status, id);
  const row = req.db.prepare(`SELECT * FROM students WHERE id = ?`).get(id);
  res.json({ ok: true, student: row });
});

// DELETE /api/roster/students/:id — soft delete (status → 'inactive').
// Idempotent: deleting an already-inactive student is still a 200 (the row
// exists); only a genuinely missing row is a 404.
router.delete('/students/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT id FROM students WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'student not found' });
  req.db.prepare(`UPDATE students SET status = 'inactive' WHERE id = ?`).run(id);
  const row = req.db.prepare(`SELECT * FROM students WHERE id = ?`).get(id);
  res.json({ ok: true, student: row });
});

/* ================= staff ================= */

// GET /api/roster/staff?include_inactive=1
router.get('/staff', (req, res) => {
  const where = activeWhere(req);
  const rows = req.db.prepare(
    `SELECT id, name, subject, contact, status FROM staff ${where ? 'WHERE ' + where : ''} ORDER BY name`
  ).all();
  res.json({ staff: rows });
});

// POST /api/roster/staff { name, subject, contact? }
router.post('/staff', (req, res) => {
  const { name, subject, contact } = req.body || {};
  const err = nonEmpty(name, 'name') || nonEmpty(subject, 'subject');
  if (err) return res.status(400).json({ error: err });
  const info = req.db.prepare(`INSERT INTO staff (name, subject, contact) VALUES (?, ?, ?)`)
    .run(name.trim(), subject.trim(), contact || null);
  const row = req.db.prepare(`SELECT * FROM staff WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, staff: row });
});

// PATCH /api/roster/staff/:id — partial update
router.patch('/staff/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'staff not found' });

  const { name, subject, contact, status } = req.body || {};
  if (name !== undefined && nonEmpty(name, 'name')) return res.status(400).json({ error: nonEmpty(name, 'name') });
  if (subject !== undefined && nonEmpty(subject, 'subject')) return res.status(400).json({ error: nonEmpty(subject, 'subject') });
  if (contact !== undefined && optString(contact)) return res.status(400).json({ error: 'contact ' + optString(contact) });
  if (status !== undefined && !STAFF_ROOM_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STAFF_ROOM_STATUSES.join(', ')}` });
  }
  req.db.prepare(
    `UPDATE staff SET name = COALESCE(?, name), subject = COALESCE(?, subject),
       contact = COALESCE(?, contact), status = COALESCE(?, status)
     WHERE id = ?`
  ).run(name === undefined ? null : name.trim(), subject === undefined ? null : subject.trim(),
        contact === undefined ? null : contact, status === undefined ? null : status, id);
  const row = req.db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id);
  res.json({ ok: true, staff: row });
});

// DELETE /api/roster/staff/:id — soft delete (idempotent, see students)
router.delete('/staff/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT id FROM staff WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'staff not found' });
  req.db.prepare(`UPDATE staff SET status = 'inactive' WHERE id = ?`).run(id);
  const row = req.db.prepare(`SELECT * FROM staff WHERE id = ?`).get(id);
  res.json({ ok: true, staff: row });
});

/* ================= rooms ================= */

// GET /api/roster/rooms?include_inactive=1
router.get('/rooms', (req, res) => {
  const where = activeWhere(req);
  const rows = req.db.prepare(
    `SELECT id, name, capacity, room_type, status FROM rooms ${where ? 'WHERE ' + where : ''} ORDER BY name`
  ).all();
  res.json({ rooms: rows });
});

// POST /api/roster/rooms { name, capacity?, room_type? }
router.post('/rooms', (req, res) => {
  const { name, capacity, room_type } = req.body || {};
  const err = nonEmpty(name, 'name');
  if (err) return res.status(400).json({ error: err });
  if (capacity !== undefined && !validPositiveInt(capacity)) {
    return res.status(400).json({ error: 'capacity must be a positive integer' });
  }
  if (room_type !== undefined && !['classroom', 'lab'].includes(room_type)) {
    return res.status(400).json({ error: 'room_type must be classroom or lab' });
  }
  try {
    const info = req.db.prepare(`INSERT INTO rooms (name, capacity, room_type) VALUES (?, ?, ?)`)
      .run(name.trim(), capacity === undefined ? 0 : Number(capacity), room_type || 'classroom');
    const row = req.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(info.lastInsertRowid);
    return res.status(201).json({ ok: true, room: row });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `a room named "${name.trim()}" already exists` });
    }
    throw e;
  }
});

// PATCH /api/roster/rooms/:id — partial update
router.patch('/rooms/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'room not found' });

  const { name, capacity, room_type, status } = req.body || {};
  if (name !== undefined && nonEmpty(name, 'name')) return res.status(400).json({ error: nonEmpty(name, 'name') });
  if (capacity !== undefined && !validPositiveInt(capacity)) {
    return res.status(400).json({ error: 'capacity must be a positive integer' });
  }
  if (room_type !== undefined && !['classroom', 'lab'].includes(room_type)) {
    return res.status(400).json({ error: 'room_type must be classroom or lab' });
  }
  if (status !== undefined && !STAFF_ROOM_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STAFF_ROOM_STATUSES.join(', ')}` });
  }
  try {
    req.db.prepare(
      `UPDATE rooms SET name = COALESCE(?, name), capacity = COALESCE(?, capacity),
         room_type = COALESCE(?, room_type), status = COALESCE(?, status)
       WHERE id = ?`
    ).run(name === undefined ? null : name.trim(), capacity === undefined ? null : Number(capacity),
          room_type === undefined ? null : room_type, status === undefined ? null : status, id);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `a room named "${name.trim()}" already exists` });
    }
    throw e;
  }
  const row = req.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id);
  res.json({ ok: true, room: row });
});

// DELETE /api/roster/rooms/:id — soft delete (idempotent, see students)
router.delete('/rooms/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = req.db.prepare(`SELECT id FROM rooms WHERE id = ?`).get(id);
  if (!existing) return res.status(404).json({ error: 'room not found' });
  req.db.prepare(`UPDATE rooms SET status = 'inactive' WHERE id = ?`).run(id);
  const row = req.db.prepare(`SELECT * FROM rooms WHERE id = ?`).get(id);
  res.json({ ok: true, room: row });
});

module.exports = router;
