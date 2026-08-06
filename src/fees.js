'use strict';
// Minimal fee ledger (Day 4) — deliberately not a billing engine.
// Balance is COMPUTED from payments (expected_fee − SUM(amount)), never
// stored, so it cannot drift from the rows it's derived from.
//
// A student with expected_fee > 0 is in balance-driven mode: reconcile()
// maps the computed balance onto the existing fee_status column
// (paid/overdue), which is what the roster badge and the fee_overdue
// notification already consume. expected_fee = 0 keeps the manual flags
// from the seed/office as authoritative (no surprise flips).

/**
 * Computed balance for one student. Returns null for unknown students.
 * @returns {{expected_fee:number, paid:number, balance:number}|null}
 */
function feeBalance(db, studentId) {
  const row = db.prepare(`SELECT expected_fee FROM students WHERE id = ?`).get(studentId);
  if (!row) return null;
  const paid = db.prepare(`SELECT COALESCE(SUM(amount), 0) total FROM payments WHERE student_id = ?`).get(studentId).total;
  return {
    expected_fee: row.expected_fee,
    paid: Math.round(paid * 100) / 100,
    balance: Math.round((row.expected_fee - paid) * 100) / 100,
  };
}

/**
 * Drive fee_status from the computed balance. Only for students in
 * balance-driven mode (expected_fee > 0). Overdue threshold is configurable
 * via FEE_OVERDUE_THRESHOLD (a small grace figure; default 0 = overdue the
 * moment the balance is positive).
 * @returns {string|null} the new fee_status, or null when untouched
 */
function reconcileStudentFees(db, studentId) {
  const b = feeBalance(db, studentId);
  if (!b || b.expected_fee <= 0) return null;
  const threshold = Number(process.env.FEE_OVERDUE_THRESHOLD) || 0;
  const status = b.balance <= threshold ? 'paid' : 'overdue';
  db.prepare(`UPDATE students SET fee_status = ? WHERE id = ?`).run(status, studentId);
  return status;
}

module.exports = { feeBalance, reconcileStudentFees };
