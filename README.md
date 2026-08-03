# SchoolVerse

An AI-powered school operations platform — paperwork in, system out. Express + SQLite backend, vanilla HTML/CSS/JS frontend (no build step), single-admin auth.

**Landing page** (public, shows real read-only data): `/`
**Dashboard app** (sign-in required): `/dashboard.html`

---

## Quick start

Requires **Node ≥ 20** (developed on Node 22).

```bash
npm install        # install dependencies
npm run setup      # create the schema (idempotent) + load dev seed data
npm start          # run the server → http://localhost:3000
```

Then open:

| URL | What it is |
|---|---|
| `http://localhost:3000/` | Landing page — marketing sections + live read-only data (stats, timetable, notifications) |
| `http://localhost:3000/login.html` | Admin sign-in |
| `http://localhost:3000/dashboard.html` | Dashboard app (redirects to login when signed out) |

### Seeded admin account (local dev only)

```
email:    admin@schoolverse.local
password: admin123
```

Override with env vars when seeding: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`.

---

## Development

```bash
npm run dev        # server with auto-restart on file change (node --watch)
npm test           # unit tests (node:test)
```

### Scripts

| Script | What it does |
|---|---|
| `npm start` | Run the server (also migrates + kicks off the background scan on boot) |
| `npm run dev` | Run with `node --watch` for development |
| `npm run db:migrate` | Apply `db/schema.sql` (idempotent, safe to re-run) |
| `npm run db:seed` | Load dev sample data (see below) |
| `npm run setup` | `db:migrate` + `db:seed` in one step |
| `npm test` | Run the conflict-detector unit tests |

### Dev seed data

`npm run db:seed` (or `db/seeds/dev-seed.js`) wipes and repopulates the database with realistic sample rows: 8 rooms, 6 staff, 6 students, a full 5-day timetable with **deliberately seeded conflicts** (a live room clash, an auto-resolved slot, and a staffing gap), 5 days of mixed-method attendance (RFID/CV/manual), 4 uploaded forms (3 pending review), and the admin account.

> `// dev seed data — do not run in production` — the script refuses to run when `NODE_ENV=production`.

The seed is strictly for local development/demo. It is separated from production by the NODE_ENV guard, and nothing it produces is presented as production content.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `db/schoolverse.db` | SQLite file location |
| `SESSION_SECRET` | local-dev default | HMAC secret for the signed session cookie — **set a real value when deploying** |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | `admin@schoolverse.local` / `admin123` | Admin credentials written by the dev seed |

---

## Architecture

```
server.js                  Express entry — static serving, route mounting, auth guard, error handler, background scan
db/
  schema.sql               All tables + indexes (portable SQL — SQLite-flavoured, Postgres-able)
  migrate.js               Idempotent schema runner
  seeds/dev-seed.js        DEV-ONLY sample data (refuses to run in production)
src/
  db.js                    better-sqlite3 connection (WAL mode, FK enforcement)
  auth.js                  Signed-cookie sessions (HMAC-SHA256) + bcrypt password hashing
  conflict-detector.js     Real timetable conflict detection (staff/room double-booking)
  notification-service.js  Generates notifications from real conflicts/pending forms/staffing gaps
  stats.js                 Real aggregate queries for the stats section
routes/                    /api/* handlers (auth, stats, timetable, notifications, forms, attendance, roster)
public/
  index.html               Landing page (data sections fetch live API)
  dashboard.html           Dashboard app view (post-login product UI)
  login.html               Sign-in
  styles.css               Shared token system (navy #14213D, paper #FAF7F0, gold #C9A227, teal #2F6F63)
  app.js                   Shared fetch helpers + skeleton/empty/error state rendering
tests/
  conflict-detector.test.js  Unit tests for conflict detection (node:test, in-memory DB)
```

### API overview

**Public (read-only previews for the landing page):**

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/stats` | Real aggregates (forms verified, clashes auto-resolved, attendance %, students) |
| GET | `/api/timetable` | Weekly grid with conflict state |
| GET | `/api/notifications` | Open attention items |
| POST | `/api/auth/login` | Public — returns session cookie |

**Require a session cookie (`/api/*` after the auth guard):**

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/auth/me` | Current admin (self-guarded) |
| POST | `/api/auth/logout` | Clears session |
| GET/POST | `/api/forms` | List / upload a form (multipart) — upload → `pending_review` row; actual OCR is a stubbed TODO |
| PATCH | `/api/forms/:id/verify` | Mark a form verified |
| PATCH | `/api/forms/:id/reject` | Mark a form rejected |
| POST | `/api/timetable/detect-conflicts` | Run conflict detection |
| POST | `/api/timetable/slots` | Add a slot (auto-checks conflicts) |
| PATCH | `/api/timetable/slots/:id/reassign` | Move a slot; full rescan auto-clears peers + resolves notifications |
| PATCH | `/api/notifications/:id/resolve` | Resolve an item |
| GET | `/api/attendance` | Attendance records + method breakdown |
| GET | `/api/roster` | Students/staff/rooms for the data hub |

### How the "proactive" pieces actually work

- **Conflict detection** — `src/conflict-detector.js` checks every slot for the same `staff_id` or `room_id` at the same day+period. Slots are flagged `conflict=1` with a reason; the timetable API renders them as the red clash state. Reassigning a slot triggers a **full rescan**, so a moved slot's peers clear automatically.
- **Notifications** — `src/notification-service.js` (`runScan`) inspects real state: conflicts, `uploaded_forms` stuck in `pending_review`, and timetable slots with no teacher (staffing gaps). Each gets a `notifications` row with a **fingerprint** so repeated scans never spam duplicates. Runs at boot, every 60s, and after any mutation (detect/reassign/upload).
- **Dashboard** — the attention queue renders from real `notifications` rows; Approve/Review/Fix buttons call real PATCH endpoints that update the database and re-run the scan.

---

## Testing

```bash
npm test
```

Runs `tests/conflict-detector.test.js` (6 tests) against an in-memory SQLite database covering staff clashes, room clashes, self-conflicts, resolution transitions, and the no-teacher gap.

---

## Notes for later

- **OCR is stubbed** — the upload flow stores the file and a `pending_review` row, but `extracted_data` for uploads is not yet AI-extracted. Wire a vision model into `routes/forms.js` when ready.
- **Sessions** are signed cookies (stateless, restart-safe). Swap for real session storage / Passport / roles when multi-admin comes.
- **Postgres migration** — the SQL is portable (only `AUTOINCREMENT`/`datetime('now')`/`?` placeholders are SQLite-flavoured). Swapping `src/db.js` for `pg` is a mechanical change.
- **Background scan** is a `setInterval` — in production run `runScan` as a cron job instead.
