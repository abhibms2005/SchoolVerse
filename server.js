'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const { openDb } = require('./src/db');
const { migrate } = require('./db/migrate');
const { requireAuth, getSession } = require('./src/auth');
const { runScan } = require('./src/notification-service');

const PORT = Number(process.env.PORT) || 3000;

const app = express();
const db = openDb();

// Attach the db handle to every request so route files stay lean.
app.use((req, res, next) => { req.db = db; next(); });

app.disable('x-powered-by');
app.use(express.json());

// Ensure the uploads directory exists before multer writes there.
fs.mkdirSync(path.join(__dirname, 'public', 'uploads'), { recursive: true });

/* ------------------------------------------------------------------
   Dashboard guard MUST run before express.static, otherwise the
   static file middleware would serve /dashboard.html to anyone.
   ------------------------------------------------------------------ */
app.use('/dashboard.html', (req, res, next) => {
  if (!getSession(req)) return res.redirect('/login.html');
  next();
});

// Static frontend + uploaded files.
app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/stats', require('./routes/stats'));
app.use('/api/timetable', publicOnly(require('./routes/timetable')));
app.use('/api/notifications', publicOnly(require('./routes/notifications')));

// Everything after this point requires a session cookie.
app.use('/api', requireAuth);
app.use('/api/timetable', require('./routes/timetable'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/forms', require('./routes/forms'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/roster', require('./routes/roster'));

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
   Scheduled background scan (real, but dev-appropriate: a setInterval).
   In production you'd run this as a cron job instead. Re-scans the
   timetable for conflicts and generates notifications. Fingerprints
   dedupe, so re-runs never spam.
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

app.listen(PORT, () => {
  console.log('┌────────────────────────────────────────────────┐');
  console.log(`│  SchoolVerse running at http://localhost:${PORT}`);
  console.log(`│  Landing:  http://localhost:${PORT}/`);
  console.log(`│  Dashboard: http://localhost:${PORT}/dashboard.html  (sign in first)`);
  console.log('└────────────────────────────────────────────────┘');
});
