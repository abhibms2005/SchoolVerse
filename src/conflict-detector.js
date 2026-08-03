'use strict';
// Real conflict detection for timetable_slots.
// A slot conflicts when another slot at the same day+period shares its
// staff_id (teacher double-booked) or room_id (room double-booked).

/**
 * Find conflicts for one slot against the rest of the timetable.
 * @param {object} db  better-sqlite3 database handle
 * @param {object} slot  { id?, day, period, staff_id, room_id }
 * @returns {Array<{kind:'staff'|'room', withSlotId:number, reason:string}>}
 */
function findSlotConflicts(db, slot) {
  const peers = db.prepare(
    `SELECT id, staff_id, room_id, class_section, subject
       FROM timetable_slots
      WHERE day = ? AND period = ? AND id != ?`
  ).all(slot.day, slot.period, slot.id || -1);

  const issues = [];
  for (const peer of peers) {
    if (slot.staff_id != null && peer.staff_id === slot.staff_id) {
      issues.push({
        kind: 'staff',
        withSlotId: peer.id,
        reason: `Teacher ${peer.class_section} ${peer.subject} also booked`,
      });
    }
    if (slot.room_id != null && peer.room_id === slot.room_id) {
      issues.push({
        kind: 'room',
        withSlotId: peer.id,
        reason: `Room also used by ${peer.class_section} ${peer.subject}`,
      });
    }
  }
  return issues;
}

/**
 * Mark a single slot's conflict flag based on its current peers.
 * Also handles the resolved_from_conflict transition: when a previously
 * conflicted slot becomes clean, we remember it was auto-fixed.
 */
function refreshSlotConflict(db, slotId) {
  const slot = db.prepare(`SELECT * FROM timetable_slots WHERE id = ?`).get(slotId);
  if (!slot) return { issues: [] };

  const issues = findSlotConflicts(db, slot);
  const wasConflicted = slot.conflict === 1;

  if (issues.length === 0) {
    db.prepare(
      `UPDATE timetable_slots
          SET conflict = 0, conflict_reason = NULL,
              resolved_from_conflict = CASE WHEN ? = 1 THEN 1 ELSE resolved_from_conflict END
        WHERE id = ?`
    ).run(wasConflicted ? 1 : 0, slotId);
  } else {
    const reason = issues.map((i) => i.reason).join('; ');
    // Re-conflicting a slot also clears its old resolved_from_conflict marker.
    db.prepare(`UPDATE timetable_slots SET conflict = 1, conflict_reason = ?, resolved_from_conflict = 0 WHERE id = ?`)
      .run(reason, slotId);
  }
  return { issues, slot };
}

/**
 * Scan the entire timetable, flagging every conflicting slot.
 * Returns the list of slots that currently have conflicts.
 */
function scanAllConflicts(db) {
  const slots = db.prepare(`SELECT * FROM timetable_slots`).all();
  const flagged = [];
  for (const slot of slots) {
    const { issues } = refreshSlotConflict(db, slot.id);
    if (issues.length > 0) {
      flagged.push({ slot, issues });
    }
  }
  return flagged;
}

module.exports = { findSlotConflicts, refreshSlotConflict, scanAllConflicts };
