'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mountRouter } = require('./helpers');
const { runScan } = require('../src/notification-service');
const paymentsRouter = require('../routes/payments');

function seedStudent(db, { expected = 45000 } = {}) {
  const s = db.prepare(`INSERT INTO students (name, class, section, fee_status, status, expected_fee) VALUES ('R. Verma', '10B', 'B', 'pending', 'active', ?)`).run(expected).lastInsertRowid;
  return s;
}

test('recording a payment updates the computed balance', async () => {
  const h = await mountRouter(paymentsRouter, '/api/payments', { email: 'a@school', role: 'admin' });
  try {
    const sid = seedStudent(h.db); // expected 45000, paid 0
    const res = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: sid, amount: 15000 }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.balance.paid, 15000);
    assert.equal(body.balance.balance, 30000);
    assert.equal(body.fee_status, 'overdue');
    // A second payment takes the balance to 0 → paid.
    const res2 = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: sid, amount: 30000 }),
    });
    const body2 = await res2.json();
    assert.equal(body2.balance.balance, 0);
    assert.equal(body2.fee_status, 'paid');
  } finally { await h.close(); }
});

test('payment validation: unknown student 404, bad amount 400', async () => {
  const h = await mountRouter(paymentsRouter, '/api/payments', { email: 'a@school', role: 'admin' });
  try {
    const sid = seedStudent(h.db);
    const unknown = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: 9999, amount: 100 }),
    });
    assert.equal(unknown.status, 404);
    const zero = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: sid, amount: 0 }),
    });
    assert.equal(zero.status, 400);
    const neg = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: sid, amount: -5 }),
    });
    assert.equal(neg.status, 400);
    const nan = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ student_id: sid, amount: 'abc' }),
    });
    assert.equal(nan.status, 400);
    const noStudent = await fetch(`${h.base}/api/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    });
    assert.equal(noStudent.status, 400);
  } finally { await h.close(); }
});

test('overdue fee notification fires once and is not duplicated by repeated scans', async () => {
  const h = await mountRouter(paymentsRouter, '/api/payments', { email: 'a@school', role: 'admin' });
  try {
    const sid = seedStudent(h.db); // expected 45000, no payments → overdue balance
    await fetch(`${h.base}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: sid, amount: 5000 }) });
    runScan(h.db);
    runScan(h.db);
    runScan(h.db);
    const rows = h.db.prepare(`SELECT COUNT(*) c FROM notifications WHERE type = 'fee_overdue' AND fingerprint = ?`).get(`fee_overdue_${sid}`);
    assert.equal(rows.c, 1);
    assert.equal(h.db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = ?`).get(`fee_overdue_${sid}`).resolved, 0);
  } finally { await h.close(); }
});

test('notification clears when the balance is paid off', async () => {
  const h = await mountRouter(paymentsRouter, '/api/payments', { email: 'a@school', role: 'admin' });
  try {
    const sid = seedStudent(h.db);
    // Go overdue first: partial payment → balance positive → notification fires.
    await fetch(`${h.base}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: sid, amount: 1000 }) });
    runScan(h.db);
    assert.equal(h.db.prepare(`SELECT resolved FROM notifications WHERE fingerprint = ?`).get(`fee_overdue_${sid}`).resolved, 0);
    // Pay the rest → balance 0 → reconciled to paid → notification resolves.
    await fetch(`${h.base}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: sid, amount: 44000 }) });
    runScan(h.db);
    const row = h.db.prepare(`SELECT resolved, type FROM notifications WHERE fingerprint = ?`).get(`fee_overdue_${sid}`);
    assert.equal(row.type, 'fee_overdue');
    assert.equal(row.resolved, 1); // paid off → resolved
  } finally { await h.close(); }
});

test('fee status badge source is consistent: roster shows the reconciled value', async () => {
  const h = await mountRouter(paymentsRouter, '/api/payments', { email: 'a@school', role: 'admin' });
  try {
    const sid = seedStudent(h.db, { expected: 1000 });
    await fetch(`${h.base}/api/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ student_id: sid, amount: 1000 }) });
    assert.equal(h.db.prepare(`SELECT fee_status FROM students WHERE id = ?`).get(sid).fee_status, 'paid');
  } finally { await h.close(); }
});
