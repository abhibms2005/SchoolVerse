'use strict';
// Real aggregate stats computed from the database.
// If the DB is empty, `has_data` is false so the UI can show an honest
// empty state instead of a made-up number.

function getStats(db) {
  const count = (sql) => db.prepare(sql).get().c;

  const students = count(`SELECT COUNT(*) c FROM students`);
  const staff = count(`SELECT COUNT(*) c FROM staff`);
  const rooms = count(`SELECT COUNT(*) c FROM rooms`);

  const formsVerified = count(`SELECT COUNT(*) c FROM uploaded_forms WHERE status = 'verified'`);
  const formsPending = count(`SELECT COUNT(*) c FROM uploaded_forms WHERE status = 'pending_review'`);
  const formsTotal = count(`SELECT COUNT(*) c FROM uploaded_forms`);

  // Clashes the system flagged (one notification per clashing slot).
  const clashesDetected = count(`SELECT COUNT(*) c FROM notifications WHERE type = 'clash'`);
  // Clashes the system auto-rebooked — slots marked resolved_from_conflict.
  // (Counts timetable state, not notifications, so it matches the grid's
  //  "AUTO-RESOLVED" cells even though those slots never raised a live clash.)
  const clashesResolved = count(`SELECT COUNT(*) c FROM timetable_slots WHERE resolved_from_conflict = 1`);
  const staffingGaps = count(`SELECT COUNT(*) c FROM notifications WHERE type = 'staffing_gap' AND resolved = 0`);
  // True open attention-queue size — every unresolved notification (clash,
  // pending form, staffing gap). Used by the dashboard's "Open items" card.
  const openNotifications = count(`SELECT COUNT(*) c FROM notifications WHERE resolved = 0`);

  const attendanceTotal = count(`SELECT COUNT(*) c FROM attendance_records`);
  const attendanceAuto = count(`SELECT COUNT(*) c FROM attendance_records WHERE method IN ('RFID', 'CV')`);
  const attendanceAutoPct = attendanceTotal > 0 ? Math.round((attendanceAuto / attendanceTotal) * 1000) / 10 : 0;

  return {
    students,
    staff,
    rooms,
    forms_verified: formsVerified,
    forms_pending: formsPending,
    forms_total: formsTotal,
    clashes_detected: clashesDetected,
    clashes_resolved: clashesResolved,
    staffing_gaps: staffingGaps,
    open_notifications: openNotifications,
    attendance_total: attendanceTotal,
    attendance_auto: attendanceAuto,
    attendance_auto_pct: attendanceAutoPct,
    has_data: students > 0 || formsTotal > 0 || attendanceTotal > 0,
  };
}

module.exports = { getStats };
