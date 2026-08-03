# SchoolVerse

An AI-powered school operations platform — paperwork in, system out. Express + SQLite backend, vanilla HTML/CSS/JS frontend (no build step), single-admin auth.

**Landing page** (public, shows real read-only data): `/`
**Dashboard app** (sign-in required): `/dashboard.html`

---

## Quick start

Requires **Node 22.x** — pinned via `engines.node` in `package.json` (and `NODE_VERSION` in `render.yaml`). This matters on Render: better-sqlite3 11.x ships prebuilt binaries for Node 22 but not for newer runtimes like Node 26, so an open range lets Render pick a version whose native build fails. Upgrade to the N-API-based better-sqlite3 13.x when you want to move to a newer Node.

```bash
npm install        # install dependencies
npm run setup      # create the schema (idempotent) + load dev seed data
npm start          # run the server → http://localhost:3000
```

> `npm run setup` / `npm run db:seed` need `SEED_ADMIN_EMAIL` and
> `SEED_ADMIN_PASSWORD` set (see below) — the repo contains no default admin
> credentials.

Then open:

| URL | What it is |
|---|---|
| `http://localhost:3000/` | Landing page — marketing sections + live read-only data (stats, timetable, notifications) |
| `http://localhost:3000/login.html` | Admin sign-in |
| `http://localhost:3000/dashboard.html` | Dashboard app (redirects to login when signed out) |

### Seeded admin account (local dev only)

The seed writes the admin account from environment variables — **no default
credentials are committed**. When seeding (`npm run setup` / `npm run db:seed`)
you must supply them:

```bash
SEED_ADMIN_EMAIL=admin@your-school.org SEED_ADMIN_PASSWORD='pick-a-strong-password' npm run setup
```

The server also refuses to boot with `SEED_DEMO_ON_BOOT=true` unless both
variables are set.

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
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | *(required when seeding — no default)* | Admin credentials for the seeded account; the seed and `SEED_DEMO_ON_BOOT` boot provisioning refuse to run without them |
| `SEED_DEMO_ON_BOOT` | *(unset)* | `true` → seed demo data on boot **only when the database is empty** (used for ephemeral hosting — see below) |
| `UPLOADS_DIR` | `public/uploads` | Where uploaded form files are stored (point at a persistent disk in production) |

---

## Deploying to Render

The whole app (landing page, dashboard, login, uploads) is an Express + SQLite
server — it must run on a host that executes Node, **not** a static file host
(Netlify etc. can only serve the frontend, which is why the live sections 404
there). The repo ships a [`render.yaml`](render.yaml) blueprint for one-click
deployment.

### Deploy steps

1. Push this repo to GitHub (already done — `origin` → `github.com/abhibms2005/schoolai`).
2. Sign up at [render.com](https://render.com) → **New → Blueprint**.
3. Connect the GitHub repo. Render reads `render.yaml` and creates the web service automatically.
4. First deploy builds, then boots the server. Watch the logs for `SchoolVerse running at http://…`.
5. During blueprint creation Render prompts you for `SEED_ADMIN_EMAIL` and
   `SEED_ADMIN_PASSWORD` — they're deliberately left out of `render.yaml` (no
   default credentials are committed, and the server refuses to boot without
   them). You can change them later in the Render dashboard → Settings →
   Environment.
6. Open the service URL and sign in with the credentials you provided.

### ⚠️ Free tier wipes your SQLite data — read this before choosing

**Confirmed from Render's docs:** free-instance web services have an
*ephemeral filesystem* — "any changes to your web service's filesystem
(uploaded images, local SQLite databases, etc.) are lost every time the service
redeploys, restarts, or spins down." Free services also **spin down after ~15
minutes of inactivity** (and wake on the next request), and *"persistent disks
… can preserve local filesystem changes, but Free web services cannot."*

What that means in practice:

| | Free tier | Paid instance + disk |
|---|---|---|
| Cost | $0 | ~$7–25/mo instance (see [pricing](https://render.com/pricing)) + disk (~$0.25/GB/mo, min 1 GB) |
| Data survives restarts/redeploys | ❌ **No — wiped every restart, redeploy and spin-down** | ✅ Yes |
| Dashboard / login / uploads | Work, but **reset to demo state** after ~15 min idle | Fully persistent |
| Demo data | Auto re-seeded on boot (`SEED_DEMO_ON_BOOT=true`) | Seeded once, then keeps what you enter |

**For a hackathon demo:** the free tier is acceptable *if* you're OK with the
app resetting to the demo state whenever it idles out — the site always looks
alive because `SEED_DEMO_ON_BOOT` re-seeds a fresh demo DB on boot, and your
admin login still works. Anything you type into the dashboard (uploaded forms,
resolved notifications, timetable edits) is lost when the service sleeps.

**For real persistence:** pick a paid instance type and attach a disk. In
`render.yaml` change `plan: free` → `plan: standard`, uncomment the `disk:`
block, and keep `DB_PATH=/var/data/schoolverse.db` + `UPLOADS_DIR=/var/data/uploads`
(they're already set — they only persist once the disk is mounted at `/var/data`).
Then your data survives restarts, redeploys and idle spin-down.

> Note: SQLite + WAL works fine on Render's attached SSDs. Backups are on you
> (Render snapshots the disk daily, but for a real deployment consider `VACUUM
> INTO` dumps or a cron `sqlite3 .backup`).

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
