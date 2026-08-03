'use strict';
// Generates real notification rows from real database state.
// Deduped via a unique `fingerprint` so repeated scans never duplicate.
const { scanAllConflicts } = require('./conflict-detector');

function upsertNotification(db, { type, message, severity, fingerprint }) {
  db.prepare(
    `INSERT OR IGNORE INTO notifications (type, message, severity, resolved, fingerprint)
     VALUES (?, ?, ?, 0, ?)`
  ).run(type, message, severity, fingerprint);
}

function notifyClashes(db, flagged) {
  for (const { slot, issues } of flagged) {
    const reason = issues.map((i) => i.reason).join('; ');
    upsertNotification(db, {
      type: 'clash',
      message: `Timetable clash: ${slot.class_section} ${slot.subject} — ${reason}`,
      severity: 'urgent',
      fingerprint: `clash_${slot.id}_${slot.day}_${slot.period}`,
    });
  }
}

function notifyPendingForms(db) {
  const pending = db.prepare(
    `SELECT f.*, s.name AS student_name
       FROM uploaded_forms f
       LEFT JOIN students s ON s.id = f.student_id
      WHERE f.status = 'pending_review'`
  ).all();
  for (const form of pending) {
    upsertNotification(db, {
      type: 'pending_review',
      message: `${form.form_type} form for ${form.student_name || `student #${form.student_id || '?'}`} awaits review`,
      severity: 'warning',
      fingerprint: `pending_form_${form.id}`,
    });
  }
}

function notifyStaffingGaps(db) {
  const gaps = db.prepare(
    `SELECT ts.*, r.name AS room_name
       FROM timetable_slots ts
       LEFT JOIN rooms r ON r.id = ts.room_id
      WHERE ts.staff_id IS NULL`
  ).all();
  for (const gap of gaps) {
    upsertNotification(db, {
      type: 'staffing_gap',
      message: `Staffing gap: ${gap.class_section} ${gap.subject} has no teacher assigned (${gap.room_name || 'no room'})`,
      severity: 'warning',
      fingerprint: `staffing_gap_${gap.id}`,
    });
  }
}

/**
 * Close notifications whose underlying issue has been fixed.
 * Reconstructs each fingerprint from the live tables, so notifications
 * resolve themselves once the slot/form is no longer in a bad state.
 */
function resolveResolvedIssues(db) {
  db.prepare(
    `UPDATE notifications SET resolved = 1
      WHERE type = 'clash' AND resolved = 0
        AND fingerprint IN (
          SELECT 'clash_' || id || '_' || day || '_' || period
            FROM timetable_slots WHERE conflict = 0
        )`
  ).run();
  db.prepare(
    `UPDATE notifications SET resolved = 1
      WHERE type = 'staffing_gap' AND resolved = 0
        AND fingerprint IN (
          SELECT 'staffing_gap_' || id
            FROM timetable_slots WHERE staff_id IS NOT NULL
        )`
  ).run();
  db.prepare(
    `UPDATE notifications SET resolved = 1
      WHERE type = 'pending_review' AND resolved = 0
        AND fingerprint IN (
          SELECT 'pending_form_' || id
            FROM uploaded_forms WHERE status != 'pending_review'
        )`
  ).run();
}

/**
 * Full scheduled/triggered scan: re-detect conflicts, then generate any
 * missing notifications and close notifications for resolved issues.
 */
function runScan(db) {
  const flagged = scanAllConflicts(db);
  notifyClashes(db, flagged);
  notifyPendingForms(db);
  notifyStaffingGaps(db);
  resolveResolvedIssues(db);
  return { clashes: flagged.length };
}

module.exports = { runScan, upsertNotification, resolveResolvedIssues };
