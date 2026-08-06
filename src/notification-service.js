'use strict';
// Generates real notification rows from real database state.
// Deduped via a unique `fingerprint` so repeated scans never duplicate.
const { scanAllConflicts } = require('./conflict-detector');
const { suggestStaffing } = require('./staffing-predictor');

function upsertNotification(db, { type, message, severity, fingerprint, student_id, slot_id, staff_id }) {
  // INSERT OR IGNORE: a notification is created once. Resolving it — either
  // automatically (issue fixed) or by the admin's "Mark resolved" button —
  // must stick; the next scan must NOT force-reopen a dismissed row.
  // student_id/slot_id/staff_id are optional refs (teacher scoping, staffing
  // suggestions' one-click accept).
  db.prepare(
    `INSERT OR IGNORE INTO notifications (type, message, severity, resolved, fingerprint, student_id, slot_id, staff_id)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  ).run(type, message, severity, fingerprint, student_id ?? null, slot_id ?? null, staff_id ?? null);
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
    let extracted = null;
    try { extracted = form.extracted_data ? JSON.parse(form.extracted_data) : null; } catch { extracted = null; }
    // One row per form: a low-confidence / needs-review extraction gets the
    // specific "manual review — low OCR confidence" row (which also implies
    // the review is awaited), anything else gets the generic one. Emitting
    // both for the same form would look like a duplicate in the queue.
    const lowConfidence = form.extraction_status === 'done' && extracted
      && (Number(extracted.confidence) < 0.6 || extracted.needs_human_review === true);
    // student_id rides along so teacher-scoped views (Day 1–2) surface the
    // SAME rows the admin sees — including the low-confidence reason — instead
    // of re-synthesising a generic message from the forms table.
    if (lowConfidence) {
      const pct = Math.round((Number(extracted.confidence) || 0) * 100);
      upsertNotification(db, {
        type: 'pending_review',
        message: `${form.form_type} form for ${form.student_name || `student #${form.student_id || '?'}`} needs manual review — low OCR confidence (${pct}%)`,
        severity: 'warning',
        fingerprint: `low_conf_form_${form.id}`,
        student_id: form.student_id,
      });
      continue;
    }
    upsertNotification(db, {
      type: 'pending_review',
      message: `${form.form_type} form for ${form.student_name || `student #${form.student_id || '?'}`} awaits review`,
      severity: 'warning',
      fingerprint: `pending_form_${form.id}`,
      student_id: form.student_id,
    });
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

const STAFFING_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Consecutive absences that trigger an alert (Day 5). A student absent this
// many school days in a row lands in the attention queue — and in their
// teacher's scoped view via student_id.
const CONSECUTIVE_ABSENCE_THRESHOLD = 3;

/**
 * Absence alerts from REAL scan rows: for each active student, count
 * consecutive calendar-day absences ending at their most recent attendance
 * record. At/above the threshold → an `absence` notification (fingerprint
 * per student, re-opened while it applies, resolved the moment they attend).
 */
function notifyAbsences(db) {
  const students = db.prepare(`SELECT id, name, class FROM students WHERE status = 'active'`).all();
  const active = new Set();
  for (const s of students) {
    const rows = db.prepare(
      `SELECT date, status FROM attendance_records WHERE student_id = ? ORDER BY date DESC`
    ).all(s.id);
    let run = 0;
    let cursor = null;
    for (const r of rows) {
      if (r.status !== 'absent') break;            // a present/late day ends the run
      const t = new Date(r.date + 'T00:00:00Z');
      if (cursor === null) { cursor = t; run = 1; }
      else {
        if ((cursor - t) / 86400000 !== 1) break;  // a calendar gap ends the run
        cursor = t; run += 1;
      }
    }
    if (run >= CONSECUTIVE_ABSENCE_THRESHOLD) {
      active.add(s.id);
      const message = `Absence alert: ${s.name} (${s.class}) has been absent ${run} consecutive days`;
      const fp = `absence_${s.id}`;
      db.prepare(`UPDATE notifications SET resolved = 0, message = ? WHERE type = 'absence' AND fingerprint = ?`).run(message, fp);
      upsertNotification(db, { type: 'absence', message, severity: 'warning', fingerprint: fp, student_id: s.id });
    }
  }
  // Resolve students who attended (run dropped below the threshold).
  db.prepare(`SELECT fingerprint FROM notifications WHERE type = 'absence' AND resolved = 0`).all().forEach((row) => {
    const id = Number(row.fingerprint.replace('absence_', ''));
    if (!active.has(id)) {
      db.prepare(`UPDATE notifications SET resolved = 1 WHERE fingerprint = ?`).run(row.fingerprint);
    }
  });
}

/**
 * Surface actionable staffing suggestions (Day 3): for each projected
 * shortfall, name a qualified teacher free at that slot — or say plainly that
 * none exists. Reconciled wholesale each scan (resolve-all, re-open current),
 * so the queue always mirrors the live outlook and an accepted/reassigned
 * slot stops suggesting. A suggestion whose suggested teacher is already on
 * the slot is skipped — nothing left to do. The Accept button in the queue
 * reassigns via the existing slot-edit write path.
 */
function notifyStaffingSuggestions(db) {
  const suggestions = suggestStaffing(db, 10);
  db.prepare(`UPDATE notifications SET resolved = 1 WHERE type = 'staffing_suggestion'`).run();
  for (const s of suggestions) {
    if (!s.slot_id) continue; // structural gap → the staffing_gap notification covers it
    const current = db.prepare(`SELECT staff_id FROM timetable_slots WHERE id = ?`).get(s.slot_id);
    if (current && s.suggestion && current.staff_id === s.suggestion.staff_id) continue; // already applied

    const fp = `staff_suggest_${s.slot_id}`;
    const when = s.day !== null ? ` on ${STAFFING_DAY_NAMES[s.day]} P${s.period}` : '';
    const action = s.suggestion
      ? ` Suggest ${s.suggestion.staff_name} — qualified and free at this slot.`
      : ` ${s.suggestion_reason}.`;
    const message = `Staffing outlook: ${s.class_section} ${s.subject}${when} — ${s.reason}.${action}`;
    db.prepare(
      `UPDATE notifications SET resolved = 0, staff_id = ?, message = ? WHERE type = 'staffing_suggestion' AND fingerprint = ?`
    ).run(s.suggestion ? s.suggestion.staff_id : null, message, fp);
    upsertNotification(db, {
      type: 'staffing_suggestion',
      message,
      severity: 'warning',
      fingerprint: fp,
      slot_id: s.slot_id,
      staff_id: s.suggestion ? s.suggestion.staff_id : null,
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
  notifyStaffingSuggestions(db);
  notifyAbsences(db);
  resolveResolvedIssues(db);
  // Record the scan time for /api/status (meta table is part of the schema).
  db.prepare(`INSERT INTO meta (key, value) VALUES ('last_scan_at', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(new Date().toISOString());
  return { clashes: flagged.length };
}

module.exports = { runScan, upsertNotification, resolveResolvedIssues, notifyGeneratedGaps, notifyAbsences, CONSECUTIVE_ABSENCE_THRESHOLD };
