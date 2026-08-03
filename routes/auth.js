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
  res.json({ email: admin.email });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me — self-guarded (this router is mounted pre-guard)
router.get('/me', requireAuth, (req, res) => {
  res.json({ email: req.admin.email });
});

module.exports = router;
