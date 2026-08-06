'use strict';
const express = require('express');
const {
  issueToken, setSessionCookie, clearSessionCookie, checkPassword, requireAuth,
} = require('../src/auth');

const router = express.Router();

// POST /api/auth/login  { email, password }
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const admin = req.db.prepare(`SELECT * FROM admins WHERE email = ?`).get(String(email).toLowerCase().trim());
  if (!admin || !checkPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  setSessionCookie(res, issueToken(admin));
  // role tells the login page where to send the user (dashboard vs teacher
  // view); staff_id lets the teacher UI know its scope without a lookup.
  res.json({ email: admin.email, role: admin.role || 'admin', staff_id: admin.staff_id || null });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — self-guarded (this router is mounted pre-guard)
router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.admin.email, role: req.admin.role || 'admin', staff_id: req.admin.staff_id || null });
});

module.exports = router;
