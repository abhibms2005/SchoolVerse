'use strict';
const express = require('express');
const { refreshSlotConflict } = require('../src/conflict-detector');
const { runScan } = require('../src/notification-service');

const router = express.Router();

// GET /api/timetable — full grid (public read-only for the landing preview)
router.get('/', (req, res) => {
  const slots = req.db.prepare(`
    SELECT ts.id, ts.day, ts.period, ts.subject, ts.class_section,
           ts.conflict, ts.conflict_reason, ts.resolved_from_conflict,
           st.name AS staff_name, st.id AS staff_id,
           r.name AS room_name, r.id AS room_id
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r   ON r.id  = ts.room_id
     ORDER BY ts.day, ts.period
  `).all();
  const rooms = req.db.prepare(`SELECT id, name, capacity FROM rooms ORDER BY name`).all();
  const staff = req.db.prepare(`SELECT id, name, subject FROM staff ORDER BY name`).all();
  res.json({ slots, rooms, staff });
});

// POST /api/timetable/detect-conflicts — trigger a full scan (authed)
router.post('/detect-conflicts', (req, res) => {
  const result = runScan(req.db);
  const flagged = req.db.prepare(
    `SELECT COUNT(*) c FROM timetable_slots WHERE conflict = 1`
  ).get().c;
  const open = req.db.prepare(
    `SELECT COUNT(*) c FROM notifications WHERE resolved = 0`
  ).get().c;
  res.json({ scanned: true, flagged_slots: flagged, open_notifications: open, new_notifications: result.clashes });
});

// PATCH /api/timetable/slots/:id/reassign  { staff_id?, room_id? } — fix a clash
router.patch('/slots/:id/reassign', (req, res) => {
  const id = Number(req.params.id);
  const slot = req.db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });

  const { staff_id, room_id } = req.body || {};
  const newStaff = staff_id === undefined ? slot.staff_id : staff_id;
  const newRoom = room_id === undefined ? slot.room_id : room_id;

  req.db.prepare(`UPDATE timetable_slots SET staff_id = ?, room_id = ? WHERE id = ?`)
    .run(newStaff, newRoom, id);

  // Full re-scan: refreshes this slot AND any peer that shared the clash,
  // generates notifications for new conflicts, and resolves notifications
  // whose underlying issue is now fixed (exact fingerprint matching — no LIKE).
  runScan(req.db);

  // Report the slot's real post-reassign conflict state (if the new room
  // collides with something else, the caller sees the remaining issues).
  const { issues } = refreshSlotConflict(req.db, id);

  const updated = req.db.prepare(`
    SELECT ts.*, st.name AS staff_name, r.name AS room_name
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r  ON r.id  = ts.room_id
     WHERE ts.id = ?`).get(id);
  res.json({ ok: true, slot: updated, remaining_issues: issues });
});

// POST /api/timetable/slots — add a new slot, run conflict detection on it (authed)
router.post('/slots', (req, res) => {
  const { day, period, subject, staff_id, room_id, class_section } = req.body || {};
  if (day == null || period == null || !subject || !class_section) {
    return res.status(400).json({ error: 'day, period, subject and class_section are required' });
  }
  const info = req.db.prepare(
    `INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(day, period, subject, staff_id ?? null, room_id ?? null, class_section);

  // Full scan so the new slot's peers get flagged too, and notifications
  // are generated for every side of any new clash.
  runScan(req.db);

  const { issues } = refreshSlotConflict(req.db, info.lastInsertRowid);
  res.status(201).json({ ok: true, slot_id: info.lastInsertRowid, conflicts: issues });
});

module.exports = router;
