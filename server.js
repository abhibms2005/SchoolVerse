'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { openDb } = require('./src/db');
const { migrate } = require('./db/migrate');
const { requireAuth, requireRole, getSession, hashPassword } = require('./src/auth');
const { runScan } = require('./src/notification-service');
const { seedIfEmpty } = require('./db/seeds/dev-seed');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const db = openDb();

// Basic security headers (X-Content-Type-Options, X-Frame-Options, HSTS in
// production, Referrer-Policy, …). Content-Security-Policy is deliberately
// left off: the pages use inline scripts/styles (no build step) and a strict
// policy would break the app for no real gain on a single-admin tool.
app.use(helmet({ contentSecurityPolicy: false }));

// Behind Render's (and most hosts') proxy, req.ip is the proxy unless Express
// trusts the first hop — the login rate limiter needs real client IPs.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

// Login brute-force guard: 10 attempts/minute per IP. Single-admin scope —
// a legitimate admin never hits this; it just slows password guessing.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many sign-in attempts — try again in a minute.' }),
});
app.use('/api/auth/login', loginLimiter);

// Attach the db handle to every request so route files stay lean.
app.use((req, res, next) => { req.db = db; next(); });

app.disable('x-powered-by');
app.use(express.json());

// Uploads directory is configurable so it can live on a persistent disk in
// production (e.g. /var/data/uploads). Defaults to public/uploads.
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/* ------------------------------------------------------------------
   Dashboard guard MUST run before express.static, otherwise the
   static file middleware would serve /dashboard.html to anyone.
   ------------------------------------------------------------------ */
app.use('/dashboard.html', (req, res, next) => {
  const session = getSession(req);
  if (!session) return res.redirect('/login.html');
  if (session.role === 'teacher') return res.redirect('/teacher.html');
  next();
});
app.use('/teacher.html', (req, res, next) => {
  const session = getSession(req);
  if (!session) return res.redirect('/login.html');
  if (session.role !== 'teacher') return res.redirect('/dashboard.html');
  next();
});

// Static frontend + uploaded files. When UPLOADS_DIR lives outside public/
// (persistent disk), this route keeps /uploads/* URLs working.
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

/* ------------------------------------------------------------------
   Public API (read-only previews so the marketing page can show real,
   honest data without a login):
   - /api/auth/*        → login is public; /me + /logout self-guard
   - GET /api/stats     → real aggregates
   - GET /api/timetable → grid with conflict state
   - GET /api/notifications → open items (small payload)
   - GET /api/health
   Mutations on these routers (detect-conflicts, reassign, resolve)
   fall through the publicOnly wrapper and hit the guard below.
   ------------------------------------------------------------------ */

// GET-only middleware: pass reads to the router, defer everything else
// to the protected mount that comes after requireAuth.
function publicOnly(router) {
  return (req, res, next) => {
    if (req.method === 'GET') return router(req, res, next);
    return next();
  };
}

app.use('/api/auth', require('./routes/auth'));                    // login public, /me self-guarded
app.get('/api/health', (req, res) => res.json({ ok: true }));
// /api/status — public read-only health detail for demos: last background
// scan, last timetable generation, and the extraction queue counters.
app.get('/api/status', (req, res) => {
  const meta = (key) => { const row = req.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key); return row ? row.value : null; };
  const ext = { pending: 0, done: 0, failed: 0 };
  for (const row of req.db.prepare(`SELECT extraction_status, COUNT(*) c FROM uploaded_forms GROUP BY extraction_status`).all()) {
    if (row.extraction_status in ext) ext[row.extraction_status] = row.c;
  }
  res.json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    last_scan_at: meta('last_scan_at'),
    last_generation_at: meta('last_generation_at'),
    extraction_queue: ext,
    node: process.version,
  });
});
app.use('/api/stats', require('./routes/stats'));
app.use('/api/timetable', publicOnly(require('./routes/timetable')));
app.use('/api/notifications', publicOnly(require('./routes/notifications')));

// Everything after this point requires a session cookie.
app.use('/api', requireAuth);
// Teacher-scoped surface (own timetable / students / alerts). Mounted BEFORE
// the admin gate so teachers are allowed here and nowhere else.
app.use('/api/teacher', requireRole('teacher', 'admin'), require('./routes/teacher'));
// The rest of the API is admin-only: roster CRUD, forms, attendance, staffing
// and every timetable mutation. A teacher session is rejected with 403.
app.use('/api', requireRole('admin'));
app.use('/api/timetable', require('./routes/timetable'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/forms', require('./routes/forms'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/roster', require('./routes/roster'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/staffing', require('./routes/staffing'));

// 404 JSON for unknown /api routes.
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Central error handler — respects client-error statuses (malformed JSON
// from express.json → 400, multer size limit → 413) instead of 500ing all.
app.use((err, req, res, next) => {
  console.error('[error]', err);
  if (res.headersSent) return next(err);
  let status = err.status || 500;
  if (err.code === 'LIMIT_FILE_SIZE') status = 413;
  res.status(status).json({ error: status >= 500 ? 'internal error' : (err.message || 'bad request') });
});

/* ------------------------------------------------------------------
   Scheduled background scan: a setInterval that re-runs the real conflict
   detector + notification generator every minute (plus once at boot), and
   records last_scan_at for /api/status. Fingerprints dedupe, so re-runs
   never spam. The same scan is also triggered by every timetable mutation.
   ------------------------------------------------------------------ */
const SCAN_INTERVAL_MS = 60 * 1000; // 60s
function scheduledScan() {
  try {
    const result = runScan(db);
    console.log(`[scan] ${new Date().toISOString()} clashes flagged: ${result.clashes}`);
  } catch (err) {
    console.error('[scan] failed:', err);
  }
}
// Run once at boot, then on the interval.
setTimeout(scheduledScan, 500);
setInterval(scheduledScan, SCAN_INTERVAL_MS);

// Apply schema on boot (idempotent) before listening.
migrate(db);

/* ------------------------------------------------------------------
   First-boot provisioning (production-safe):
   - SEED_DEMO_ON_BOOT=true → seed demo data only when the DB is empty
     (ephemeral hosts like Render's free tier wipe the file on restart,
     so this makes the app self-heal back to a demo state).
   - SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD → REQUIRED when provisioning.
     There is no hardcoded default — a known default password committed to
     the repo would be a security hole. If they're missing, the app refuses
     to boot rather than silently seeding a well-known admin account. Set
     the real values in the host's environment (Render dashboard → Settings
     → Environment).
   ------------------------------------------------------------------ */
// Production without an explicit SESSION_SECRET falls back to a hardcoded
// dev-only secret — fine locally, a real problem on a public host. Warn loudly
// (render.yaml generates one via generateValue, so the blueprint path is safe).
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('[boot] WARNING: SESSION_SECRET is not set — using a hardcoded dev-only secret. Set SESSION_SECRET in production.');
}

const ADMIN_EMAIL = String(process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || '';
const wantsSeed = process.env.SEED_DEMO_ON_BOOT === 'true';

if (wantsSeed && (!ADMIN_EMAIL || !ADMIN_PASSWORD)) {
  throw new Error('[boot] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required when SEED_DEMO_ON_BOOT=true. Set them in the Render dashboard → Settings → Environment and redeploy.');
}
if ((ADMIN_EMAIL && !ADMIN_PASSWORD) || (!ADMIN_EMAIL && ADMIN_PASSWORD)) {
  throw new Error('[boot] SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set together.');
}

if (wantsSeed) {
  if (seedIfEmpty(db)) console.log('[boot] empty database — demo data seeded');
}
if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  const existing = db.prepare('SELECT id, password_hash FROM admins WHERE email = ?').get(ADMIN_EMAIL);
  const hash = hashPassword(ADMIN_PASSWORD);
  if (!existing) {
    db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(ADMIN_EMAIL, hash);
    console.log(`[boot] admin account created from env: ${ADMIN_EMAIL}`);
  } else if (existing.password_hash !== hash) {
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hash, existing.id);
    console.log(`[boot] admin password updated from env: ${ADMIN_EMAIL}`);
  }
}
// Teacher account (optional): same env-driven pattern as the admin, but role =
// 'teacher' and linked to a staff row (default 'R. Iyer', override with
// SEED_TEACHER_STAFF_NAME) so its scope derives from real timetable data.
const TEACHER_EMAIL = String(process.env.SEED_TEACHER_EMAIL || '').toLowerCase().trim();
const TEACHER_PASSWORD = process.env.SEED_TEACHER_PASSWORD || '';
if (TEACHER_EMAIL && TEACHER_PASSWORD) {
  const teacherStaff = db.prepare(`SELECT id FROM staff WHERE name = ? AND status = 'active'`)
    .get(process.env.SEED_TEACHER_STAFF_NAME || 'R. Iyer');
  const existingTeacher = db.prepare('SELECT id, password_hash FROM admins WHERE email = ?').get(TEACHER_EMAIL);
  const teacherHash = hashPassword(TEACHER_PASSWORD);
  if (!existingTeacher) {
    db.prepare(`INSERT INTO admins (email, password_hash, role, staff_id) VALUES (?, ?, 'teacher', ?)`)
      .run(TEACHER_EMAIL, teacherHash, teacherStaff ? teacherStaff.id : null);
    console.log(`[boot] teacher account created from env: ${TEACHER_EMAIL}`);
  } else if (existingTeacher.password_hash !== teacherHash) {
    db.prepare(`UPDATE admins SET password_hash = ?, role = 'teacher', staff_id = ? WHERE id = ?`)
      .run(teacherHash, teacherStaff ? teacherStaff.id : null, existingTeacher.id);
    console.log(`[boot] teacher account updated from env: ${TEACHER_EMAIL}`);
  }
}

app.listen(PORT, () => {
  console.log('┌────────────────────────────────────────────────┐');
  console.log(`│  SchoolVerse running at http://localhost:${PORT}`);
  console.log(`│  Landing:  http://localhost:${PORT}/`);
  console.log(`│  Dashboard: http://localhost:${PORT}/dashboard.html  (sign in first)`);
  console.log('└────────────────────────────────────────────────┘');
});
