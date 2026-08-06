'use strict';
// Generates real notification rows from real database state.
// Deduped via a unique `fingerprint` so repeated scans never duplicate.
const { scanAllConflicts } = require('./conflict-detector');

function upsertNotification(db, { type, message, severity, fingerprint }) {
  // INSERT OR IGNORE: a notification is created once. Resolving it — either
  // automatically (issue fixed) or by the admin's "Mark resolved" button —
  // must stick; the next scan must NOT force-reopen a dismissed row.
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

    // Distinct notification for low-confidence / needs-review extractions so
    // the admin queue surfaces which forms genuinely need eyes on them.
    let extracted = null;
    try { extracted = form.extracted_data ? JSON.parse(form.extracted_data) : null; } catch { extracted = null; }
    const lowConfidence = form.extraction_status === 'done' && extracted
      && (Number(extracted.confidence) < 0.6 || extracted.needs_human_review === true);
    if (lowConfidence) {
      const pct = Math.round((Number(extracted.confidence) || 0) * 100);
      upsertNotification(db, {
        type: 'pending_review',
        message: `${form.form_type} form for ${form.student_name || `student #${form.student_id || '?'}`} needs manual review — low OCR confidence (${pct}%)`,
        severity: 'warning',
        fingerprint: `low_conf_form_${form.id}`,
      });
    }
  }
}

function notifyOverdueFees(db) {
  const overdue = db.prepare(
    `SELECT id, name, class FROM students WHERE status = 'active' AND fee_status = 'overdue'`
  ).all();
  // Fees are the one notification whose lifecycle is a true state machine
  // (overdue → paid → overdue again), so re-opening is wanted here even for
  // rows that were resolved earlier. Scoped to fee rows only — the generic
  // upsert stays INSERT OR IGNORE so "Mark resolved" sticks for other types.
  db.prepare(
    `UPDATE notifications SET resolved = 0
      WHERE type = 'fee_overdue' AND resolved = 1
        AND fingerprint IN (
          SELECT 'fee_overdue_' || id FROM students WHERE status = 'active' AND fee_status = 'overdue'
        )`
  ).run();
  for (const s of overdue) {
    upsertNotification(db, {
      type: 'fee_overdue',
      message: `Fee overdue: ${s.name} (${s.class}) — fees flagged as overdue`,
      severity: 'warning',
      fingerprint: `fee_overdue_${s.id}`,
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
 * Surface the timetable generator's unresolved requirements as staffing-gap
 * notifications. Generation-gap fingerprints are managed wholesale by the
 * generator: each run resolves the previous run's gaps and re-creates the
 * current ones, so a fixed problem never lingers.
 */
function notifyGeneratedGaps(db, unresolved) {
  db.prepare(`UPDATE notifications SET resolved = 1 WHERE type = 'staffing_gap' AND fingerprint LIKE 'gen_gap_%'`).run();
  for (const gap of unresolved || []) {
    upsertNotification(db, {
      type: 'staffing_gap',
      message: `Staffing gap (generated): ${gap.class_section} ${gap.subject} — ${gap.reason}`,
      severity: 'warning',
      fingerprint: `gen_gap_${gap.class_section}_${gap.subject}`,
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
  db.prepare(
    `UPDATE notifications SET resolved = 1
      WHERE type = 'pending_review' AND resolved = 0
        AND fingerprint IN (
          SELECT 'low_conf_form_' || id
            FROM uploaded_forms WHERE status != 'pending_review'
        )`
  ).run();
  db.prepare(
    `UPDATE notifications SET resolved = 1
      WHERE type = 'fee_overdue' AND resolved = 0
        AND fingerprint IN (
          SELECT 'fee_overdue_' || id
            FROM students WHERE NOT (status = 'active' AND fee_status = 'overdue')
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
  notifyOverdueFees(db);
  notifyStaffingGaps(db);
  resolveResolvedIssues(db);
  // Record the scan time for /api/status (meta table is part of the schema).
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_scan_at', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(new Date().toISOString());
  return { clashes: flagged.length };
}

module.exports = { runScan, upsertNotification, resolveResolvedIssues, notifyGeneratedGaps };
