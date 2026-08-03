'use strict';
// Minimal single-admin auth.
// Session = a signed cookie (HMAC-SHA256 over a JSON payload) — no server
// session store needed, survives restarts, trivially swap-able for real
// sessions/Passport later. Passwords stored as bcrypt hashes.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'sv_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_MAX_AGE = Math.floor(SESSION_TTL_MS / 1000);

function secret() {
  // Local dev default only; override with SESSION_SECRET when deploying.
  return process.env.SESSION_SECRET || 'schoolverse-local-dev-secret-change-me';
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function readCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > -1) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function issueToken(admin) {
  return sign({ email: admin.email, exp: Date.now() + SESSION_TTL_MS });
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function getSession(req) {
  return verify(readCookies(req)[COOKIE_NAME]);
}

/** Express middleware: 401 if no valid session. */
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.admin = session;
  next();
}

/** Hash + compare helpers (bcrypt). */
function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}
function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

module.exports = {
  COOKIE_NAME,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  getSession,
  requireAuth,
  hashPassword,
  checkPassword,
};
