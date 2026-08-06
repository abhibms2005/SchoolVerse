'use strict';
// Fee ledger routes (admin-only — mounted after the admin gate).
// Recording a payment updates the student's COMPUTED balance and reconciles
// fee_status, so the existing fee_overdue notification appears/clears via the
// normal runScan path — no new notification logic.
const express = require('express');
const { feeBalance, reconcileStudentFees } = require('../src/fees');
const { runScan } = require('../src/notification-service');

const router = express.Router();

// GET /api/payments?student_id=N — payment history (+ computed balances for
// every balance-driven student, so the admin sees a real ledger, not a log).
router.get('/', (req, res) => {
  const out = { payments: [], balances: [] };

  if (req.query.student_id !== undefined) {
    const sid = Number(req.query.student_id);
    const student = req.db.prepare(`SELECT id, name, class FROM students WHERE id = ?`).get(sid);
    if (!student) return res.status(404).json({ error: `unknown student_id ${sid}` });
    out.payments = req.db.prepare(
      `SELECT p.* FROM payments p WHERE p.student_id = ? ORDER BY p.date DESC, p.id DESC`).all(sid);
    out.balances = [{ student_id: sid, name: student.name, class: student.class, ...feeBalance(req.db, sid) }];
    return res.json(out);
  }

  out.payments = req.db.prepare(`
    SELECT p.*, s.name AS student_name, s.class
      FROM payments p JOIN students s ON s.id = p.student_id
     ORDER BY p.date DESC, p.id DESC LIMIT 200`).all();
  out.balances = req.db.prepare(`SELECT id, name, class, expected_fee FROM students WHERE expected_fee > 0 ORDER BY name`)
    .all()
    .map((s) => {
      const b = feeBalance(req.db, s.id);
      return { student_id: s.id, name: s.name, class: s.class, expected_fee: b.expected_fee, paid: b.paid, balance: b.balance };
    });
  res.json(out);
});

// POST /api/payments  { student_id, amount, date?, method?, note? }
router.post('/', (req, res) => {
  const body = req.body || {};
  const sid = Number(body.student_id);
  if (!Number.isInteger(sid) || sid <= 0) {
    return res.status(400).json({ error: 'student_id (a positive integer) is required' });
  }
  const student = req.db.prepare(`SELECT id, name, class FROM students WHERE id = ? AND status = 'active'`).get(sid);
  if (!student) return res.status(404).json({ error: `unknown student_id ${sid}` });

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  let date = String(body.date || '');
  if (!date) {
    date = new Date().toISOString().slice(0, 10);
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
    return res.status(400).json({ error: 'date must be a YYYY-MM-DD string' });
  }
  const method = String(body.method || 'manual').trim() || 'manual';
  const note = body.note ? String(body.note).trim() : null;

  const info = req.db.prepare(
    `INSERT INTO payments (student_id, amount, date, method, note) VALUES (?, ?, ?, ?, ?)`
  ).run(sid, Math.round(amount * 100) / 100, date, method, note);

  // Reconcile fee_status from the new balance, then scan so the fee_overdue
  // notification appears or resolves immediately.
  const newStatus = reconcileStudentFees(req.db, sid);
  runScan(req.db);

  const payment = req.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, payment, fee_status: newStatus, balance: feeBalance(req.db, sid) });
});

module.exports = router;
