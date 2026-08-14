'use strict';
const express = require('express');
const { refreshSlotConflict, scanAllConflicts } = require('../src/conflict-detector');
const { runScan, notifyGeneratedGaps } = require('../src/notification-service');
const { generateTimetable } = require('../src/timetable-generator');

const router = express.Router();

// The real list of sections/classes the timetable knows about: the generator's
// `classes` input table PLUS any section already present in timetable_slots
// (legacy databases may have slots before the classes table was populated).
// The admin UI's section selector is built from this — never hard-coded.
function listSections(db) {
  return db.prepare(`
    SELECT name AS section FROM classes WHERE name != ''
    UNION
    SELECT DISTINCT class_section AS section FROM timetable_slots WHERE class_section != ''
    ORDER BY section`).all().map((r) => r.section);
}

// GET /api/timetable?section=9A — the full grid by default (public read-only
// for the landing preview), or a single section's slots when ?section= is
// given (the admin UI renders ONE section at a time). Always returns the
// active staff/room picklists plus the real section list for the selector.
router.get('/', (req, res) => {
  const section = typeof req.query.section === 'string' ? req.query.section.trim() : '';
  const where = section ? 'WHERE ts.class_section = ?' : '';
  const params = section ? [section] : [];
  const slots = req.db.prepare(`
    SELECT ts.id, ts.day, ts.period, ts.subject, ts.class_section,
           ts.conflict, ts.conflict_reason, ts.resolved_from_conflict,
           st.name AS staff_name, st.id AS staff_id,
           r.name AS room_name, r.id AS room_id
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r   ON r.id  = ts.room_id
     ${where}
     ORDER BY ts.day, ts.period
  `).all(...params);
  // Active-only: soft-deleted (inactive) rooms/staff are never offered for
  // reassignment or shown as assignable.
  const rooms = req.db.prepare(`SELECT id, name, capacity FROM rooms WHERE status = 'active' ORDER BY name`).all();
  const staff = req.db.prepare(`SELECT id, name, subject FROM staff WHERE status = 'active' ORDER BY name`).all();
  res.json({ slots, rooms, staff, sections: listSections(req.db) });
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

// POST /api/timetable/generate — regenerate the whole timetable from the
// generator's real input tables (classes, subjects, requirements, staff
// qualifications, rooms). Destructive (wipes existing slots) by design.
router.post('/generate', (req, res) => {
  const body = req.body || {};

  const classes = req.db.prepare(`SELECT id, name FROM classes ORDER BY name`).all();
  const subjects = req.db.prepare(`SELECT id, name FROM subjects ORDER BY name`).all();
  const requirements = req.db.prepare(`
    SELECT c.name AS class_section, s.name AS subject, cr.periods_per_week, cr.room_type
      FROM class_subject_requirements cr
      JOIN classes c ON c.id = cr.class_id
      JOIN subjects s ON s.id = cr.subject_id
     ORDER BY c.name, s.name`).all();
  const staffRows = req.db.prepare(`
    SELECT st.id, st.name, ss.subject_id, ss.max_periods_per_week
      FROM staff st
      LEFT JOIN staff_subjects ss ON ss.staff_id = st.id
     WHERE st.status = 'active'
     ORDER BY st.name`).all();
  const rooms = req.db.prepare(`SELECT id, name, room_type FROM rooms WHERE status = 'active' ORDER BY name`).all();

  // Assemble staff qualifications from the join (a teacher with no
  // staff_subjects row is simply not qualified for anything).
  const staffMap = new Map();
  for (const r of staffRows) {
    if (!staffMap.has(r.id)) {
      staffMap.set(r.id, { id: r.id, name: r.name, subjects: [], max_periods_per_week: r.max_periods_per_week || 25 });
    }
    if (r.subject_id != null) {
      const subj = subjects.find((s) => s.id === r.subject_id);
      if (subj) staffMap.get(r.id).subjects.push(subj.name);
    }
  }

  const result = generateTimetable({
    rooms,
    staff: [...staffMap.values()],
    requirements,
    periodsPerDay: Number(body.periodsPerDay) || 6,
    daysPerWeek: Number(body.daysPerWeek) || 5,
  });

  // Wipe + bulk insert inside one transaction.
  const apply = req.db.transaction(() => {
    req.db.prepare(`DELETE FROM timetable_slots`).run();
    const ins = req.db.prepare(
      `INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of result.slots) ins.run(s.day, s.period, s.subject, s.staff_id, s.room_id, s.class_section);
  });
  apply();

  // Belt-and-braces: run the real conflict detector over the inserted grid.
  // The generator guarantees zero conflicts by construction; this proves it
  // against the exact logic the dashboard trusts.
  const flagged = scanAllConflicts(req.db);
  result.summary.conflicts = flagged.length;

  // Unresolved requirements ARE staffing gaps — surface them as notifications,
  // and record the generation time for /api/status.
  notifyGeneratedGaps(req.db, result.unresolved);
  req.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_generation_at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(new Date().toISOString());

  const slots = req.db.prepare(`
    SELECT ts.id, ts.day, ts.period, ts.subject, ts.class_section,
           ts.conflict, ts.conflict_reason, ts.resolved_from_conflict,
           st.name AS staff_name, st.id AS staff_id,
           r.name AS room_name, r.id AS room_id
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r   ON r.id  = ts.room_id
     ORDER BY ts.day, ts.period`).all();

  res.json({ ok: true, slots, unresolved: result.unresolved, summary: result.summary });
});

// Validate a slot body against the schema's constraints: day/period ranges,
// required text fields, and that any staff/room ids actually exist (the UI
// only offers active ones; this catches hand-crafted requests instead of a
// 500 from the FK constraint).
function validateSlotFields(db, body) {
  const errors = [];
  // Ranges match the grid the dashboard renders (Mon-Fri x periods 1-6): a
  // slot outside them would be invisible in every view.
  if (body.day !== undefined) {
    const d = Number(body.day);
    if (!(Number.isInteger(d) && d >= 0 && d <= 4)) errors.push('day must be an integer 0-4 (0 = Monday)');
  }
  if (body.period !== undefined) {
    const p = Number(body.period);
    if (!(Number.isInteger(p) && p >= 1 && p <= 6)) errors.push('period must be an integer 1-6');
  }
  if (body.subject !== undefined && (typeof body.subject !== 'string' || !body.subject.trim())) {
    errors.push('subject must be a non-empty string');
  }
  if (body.class_section !== undefined && (typeof body.class_section !== 'string' || !body.class_section.trim())) {
    errors.push('class_section must be a non-empty string');
  }
  for (const [key, label, table] of [['staff_id', 'staff', 'staff'], ['room_id', 'room', 'rooms']]) {
    const v = body[key];
    if (v === undefined || v === null || v === '') continue; // absent or explicit clear
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push(`${key} must be a positive integer or null`);
      continue;
    }
    // Active-only: soft-deleted staff/rooms must never be assignable. The UI
    // and generator only offer active rows; this rejects hand-crafted requests.
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ? AND status = 'active'`).get(n)) errors.push(`unknown ${label}_id ${n}`);
  }
  return errors;
}

// PATCH /api/timetable/slots/:id/reassign  { subject?, class_section?, day?,
// period?, staff_id?, room_id? } — full single-slot editor. Any subset of
// fields may be sent; staff_id/room_id explicitly null clears them (a slot
// with no teacher becomes a flagged staffing gap). A full rescan then
// re-flags the slot + any new peers, clears the old cell's peers, and
// resolves notifications whose issue is fixed.
router.patch('/slots/:id/reassign', (req, res) => {
  const id = Number(req.params.id);
  const slot = req.db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });

  const body = req.body || {};
  const errors = validateSlotFields(req.db, body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const next = {
    day: body.day === undefined ? slot.day : Number(body.day),
    period: body.period === undefined ? slot.period : Number(body.period),
    subject: body.subject === undefined ? slot.subject : String(body.subject).trim(),
    class_section: body.class_section === undefined ? slot.class_section : String(body.class_section).trim(),
    staff_id: body.staff_id === undefined ? slot.staff_id : (body.staff_id === null || body.staff_id === '' ? null : Number(body.staff_id)),
    room_id: body.room_id === undefined ? slot.room_id : (body.room_id === null || body.room_id === '' ? null : Number(body.room_id)),
  };

  req.db.prepare(
    `UPDATE timetable_slots SET day = ?, period = ?, subject = ?, class_section = ?, staff_id = ?, room_id = ?
      WHERE id = ?`
  ).run(next.day, next.period, next.subject, next.class_section, next.staff_id, next.room_id, id);

  // Full re-scan: refreshes this slot AND any peer that shared the clash,
  // generates notifications for new conflicts, and resolves notifications
  // whose underlying issue is now fixed (exact fingerprint matching).
  runScan(req.db);

  // A slot moved to a new day/period leaves its OLD-cell clash notification
  // behind: fingerprints embed day/period, and runScan only reconciles
  // fingerprints it can reconstruct from live rows. Close exactly that one —
  // the pre-update `slot` row holds the old position. This must never be a
  // LIKE prefix: SQL treats `_` as a wildcard, so 'clash_1_%' would also
  // match OTHER slots' notifications (clash_10_…, clash_11_…).
  if (slot.day !== next.day || slot.period !== next.period) {
    req.db.prepare(
      `UPDATE notifications SET resolved = 1 WHERE type = 'clash' AND resolved = 0 AND fingerprint = ?`
    ).run(`clash_${id}_${slot.day}_${slot.period}`);
  }

  // Report the slot's real post-edit conflict state (if the new cell collides
  // with something else, the caller sees the remaining issues).
  const { issues } = refreshSlotConflict(req.db, id);

  const updated = req.db.prepare(`
    SELECT ts.*, st.name AS staff_name, r.name AS room_name
      FROM timetable_slots ts
      LEFT JOIN staff st ON st.id = ts.staff_id
      LEFT JOIN rooms r  ON r.id  = ts.room_id
     WHERE ts.id = ?`).get(id);
  res.json({ ok: true, slot: updated, remaining_issues: issues });
});

// DELETE /api/timetable/slots/:id — remove a single slot (authed). The slot's
// own clash/gap notifications are closed (exact fingerprint match — see the
// PATCH handler for why a LIKE prefix would over-match) and a full rescan
// un-flags any peer that only conflicted because of this slot.
router.delete('/slots/:id', (req, res) => {
  const id = Number(req.params.id);
  const slot = req.db.prepare(`SELECT id, day, period FROM timetable_slots WHERE id = ?`).get(id);
  if (!slot) return res.status(404).json({ error: 'slot not found' });

  req.db.prepare(`DELETE FROM timetable_slots WHERE id = ?`).run(id);
  req.db.prepare(
    `UPDATE notifications SET resolved = 1 WHERE type = 'clash' AND resolved = 0 AND fingerprint = ?`
  ).run(`clash_${id}_${slot.day}_${slot.period}`);
  req.db.prepare(`UPDATE notifications SET resolved = 1 WHERE fingerprint = ?`).run(`staffing_gap_${id}`);
  runScan(req.db);
  res.json({ ok: true, deleted: id });
});

// POST /api/timetable/slots — add a new slot, run conflict detection on it (authed)
router.post('/slots', (req, res) => {
  const body = req.body || {};
  if (body.day === undefined || body.period === undefined || body.subject === undefined || body.class_section === undefined) {
    return res.status(400).json({ error: 'day, period, subject and class_section are required' });
  }
  const errors = validateSlotFields(req.db, body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const info = req.db.prepare(
    `INSERT INTO timetable_slots (day, period, subject, staff_id, room_id, class_section)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Number(body.day), Number(body.period), String(body.subject).trim(),
    body.staff_id == null || body.staff_id === '' ? null : Number(body.staff_id),
    body.room_id == null || body.room_id === '' ? null : Number(body.room_id),
    String(body.class_section).trim()
  );

  // Full scan so the new slot's peers get flagged too, and notifications
  // are generated for every side of any new clash.
  runScan(req.db);

  const { issues } = refreshSlotConflict(req.db, info.lastInsertRowid);
  res.status(201).json({ ok: true, slot_id: info.lastInsertRowid, conflicts: issues });
});

module.exports = router;
