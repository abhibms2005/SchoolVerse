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
| `npm test` | Unit tests for every module (node:test, in-memory DB) |
| `npm run scan:simulate` | Run the simulated attendance hardware client (see *Auto-attendance* below) — needs `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`; `BASE_URL` (default `http://localhost:3000`), `SCAN_INTERVAL_MS` (default `4000`) and `SCAN_METHOD` (unset = weighted rotation; `rfid`/`cv`/`manual` forces one method, e.g. an all-RFID demo) are optional |

### Dev seed data

`npm run db:seed` (or `db/seeds/dev-seed.js`) wipes and repopulates the database with realistic sample rows: 8 rooms (with lab/classroom types), 6 staff, 6 students, a full 5-day timetable with **deliberately seeded conflicts** (a live room clash, an auto-resolved slot, and a staffing gap), the **timetable generator's input tables** (4 classes, 7 subjects, per-class subject requirements incl. lab needs, staff qualifications + weekly load caps), 5 days of mixed-method attendance (RFID/CV/manual), 4 uploaded forms in the document-extractor schema (3 pending review — one deliberately low-confidence to demo the review path), and the admin account.

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
| `GEMINI_API_KEY` | *(unset)* | Free Google AI Studio key for real document extraction (Task: *Document reader*). Without it, uploads still work — extraction is recorded as `failed` and the form lands in the review queue for manual entry, never a crash. Get one at aistudio.google.com/apikey (`AIza…` format) |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Gemini model used for document extraction (override per deployment; no code change needed). Defaults to the current stable Flash — older Flash models (e.g. `gemini-2.5-flash`) are restricted for new accounts |

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
block, and set `DB_PATH=/var/data/schoolverse.db` + `UPLOADS_DIR=/var/data/uploads`
(the defaults are `./data/*` inside the project dir — writable on the free
tier but wiped on restart; they only persist once the disk is mounted at
`/var/data`).
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
  notification-service.js  Generates notifications from real conflicts/pending forms/low-confidence extractions/staffing gaps
  stats.js                 Real aggregate queries for the stats section
  document-extractor.js    REAL LLM document extraction (Google Gemini generateContent, images + PDFs)
  timetable-generator.js   Dependency-free constraint-satisfaction timetable generator (backtracking)
  staffing-predictor.js    Statistical staffing-heuristic predictions from real attendance history
routes/                    /api/* handlers (auth, stats, timetable, notifications, forms, attendance, roster, staffing)
scripts/
  simulate-scanner.js      Simulated RFID/CV hardware — posts real scans to POST /api/attendance/scan
public/
  index.html               Landing page (data sections fetch live API)
  dashboard.html           Dashboard app view (post-login product UI)
  login.html               Sign-in
  styles.css               Shared token system (navy #14213D, paper #FAF7F0, gold #C9A227, teal #2F6F63)
  app.js                   Shared fetch helpers + skeleton/empty/error state rendering
tests/
  conflict-detector.test.js  Conflict detection (staff/room double-booking, resolution)
  document-extractor.test.js Real extraction parse/fallback paths (mocked model client)
  forms.test.js              Upload/verify flow incl. corrected-data merge
  timetable-generator.test.js Generation constraints + conflict-detector cross-check
  attendance-scan.test.js    Scan ingestion validation + live-feed source
  staffing-predictor.test.js Absence-heuristic + structural-gap predictions
```

### API overview

**Public (read-only previews for the landing page):**

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/status` | Demo-friendly detail: uptime, last scan, last generation, extraction queue counters |
| GET | `/api/stats` | Real aggregates (forms verified, clashes auto-resolved, attendance %, students) |
| GET | `/api/timetable` | Weekly grid with conflict state |
| GET | `/api/notifications` | Open attention items |
| POST | `/api/auth/login` | Public — returns session cookie |

**Require a session cookie (`/api/*` after the auth guard):**

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/auth/me` | Current admin (self-guarded) |
| POST | `/api/auth/logout` | Clears session |
| GET/POST | `/api/forms` | List / upload a form (multipart) — responds immediately, document extraction runs in the background |
| PATCH | `/api/forms/:id/verify` | Mark a form verified; optional `corrected_data` becomes the final extraction |
| PATCH | `/api/forms/:id/reject` | Mark a form rejected |
| PATCH | `/api/forms/:id/retry-extract` | Re-run extraction for a form stuck in `pending` (process died mid-call) or `failed` — resets the row and re-extracts in the background |
| POST | `/api/timetable/detect-conflicts` | Run conflict detection |
| POST | `/api/timetable/generate` | **Regenerate the whole timetable** from real input tables (destructive — see *Timetable generator*) |
| POST | `/api/timetable/slots` | Add a slot (auto-checks conflicts) |
| PATCH | `/api/timetable/slots/:id/reassign` | **Full single-slot editor**: change `subject`, `class_section`, `day`, `period`, `staff_id` and/or `room_id` (null clears a teacher/room). Validated, then a full rescan re-flags the new cell, un-flags old peers, and resolves stale clash notifications |
| DELETE | `/api/timetable/slots/:id` | Delete a single slot; its clash/gap notifications are closed and peers un-flagged by rescan |
| PATCH | `/api/notifications/:id/resolve` | Resolve an item |
| GET | `/api/attendance/summary` | Attendance records + method breakdown (the live feed source) |
| POST | `/api/attendance/scan` | Ingest a real scan event `{student_id, method, room_id?, timestamp?}` — the endpoint real hardware hits. **Idempotent**: one present record per student per calendar day; a re-scan (RFID double-read, rapid clicks) returns the existing row with `duplicate: true` instead of a second row |
| GET/POST | `/api/roster/students` · `/api/roster/staff` · `/api/roster/rooms` | List (active by default; `?include_inactive=1` shows soft-deleted) / create. Students carry a `fee_status` (`paid` / `pending` / `overdue`) — set it on create or edit |
| PATCH/DELETE | `/api/roster/students/:id` · `/api/roster/staff/:id` · `/api/roster/rooms/:id` | Edit / **soft delete** (row is flagged `inactive` — timetable slots, attendance and forms keep their references) |
| GET | `/api/staffing/predictions` | Staffing outlook (heuristic, real data) |

### How the "proactive" pieces actually work

- **Conflict detection** — `src/conflict-detector.js` checks every slot for the same `staff_id` or `room_id` at the same day+period. Slots are flagged `conflict=1` with a reason; the timetable API renders them as the red clash state. Reassigning a slot triggers a **full rescan**, so a moved slot's peers clear automatically.
- **Notifications** — `src/notification-service.js` (`runScan`) inspects real state: conflicts, `uploaded_forms` stuck in `pending_review` (with a distinct **"low OCR confidence"** variant for extractions below 60%), timetable slots with no teacher (staffing gaps), the generator's unresolved requirements, and students with `fee_status = 'overdue'` (**"Fee overdue"** rows, resolved the moment the fee status changes or the student is deactivated). Each gets a `notifications` row with a **fingerprint** so repeated scans never spam duplicates — and a recurring issue re-opens its row (a fixed clash that comes back, an overdue fee re-marked) instead of staying permanently resolved. Runs at boot, every 60s, and after any mutation (detect/reassign/upload/extraction/roster edit).
- **Document reader** — `src/document-extractor.js` sends the uploaded file (base64 image or PDF) to Google's **Gemini generateContent** endpoint (`gemini-3.6-flash` by default — free tier, no SDK, plain `fetch`) and parses the strict-JSON reply into the extraction schema. Every failure is stored on the form (`extraction_error` in `extracted_data`) **and** logged to the host console (`[forms] extraction failed for form #<id>: …`), so the reason is visible in deploy logs without opening the review panel. The upload responds instantly; extraction updates the row asynchronously and can never crash the server (missing API key, network failure, or malformed JSON all land as a `failed` extraction that stays in the review queue with the error surfaced). The admin reviews the extracted fields in the dashboard and can **edit before verifying** — corrections become the final `extracted_data`. A form left stuck in `pending` (process died mid-call) or `failed` can be re-run with the **Retry extraction** button (`PATCH /api/forms/:id/retry-extract`) — the row resets and the reader tries the document again.
- **Timetable generator** — `src/timetable-generator.js` is a dependency-free constraint-satisfaction solver (greedy MRV ordering + bounded backtracking) over real input tables: `classes`, `subjects`, `class_subject_requirements` (periods/week + lab vs classroom), `staff_subjects` (qualifications + weekly load caps), and `rooms.room_type`. It can't double-book a teacher, room, or class; anything it genuinely can't place is returned as an **unresolved requirement** and surfaced as a staffing-gap notification. After writing the grid it re-runs the real conflict detector as a belt-and-braces check (zero conflicts by construction, proven at runtime). Manual editing still works afterwards: every timetable cell in the dashboard has an **Edit** control (modal for subject / class / teacher / room / day / period), a **Delete slot** action, and an **Add slot** button — all wired to `POST/PATCH/DELETE /api/timetable/slots*`, each change triggering the same rescan-and-resolve flow as the generator's output.
- **Auto-attendance** — `POST /api/attendance/scan` writes a real attendance row for `{student_id, method: rfid|cv|manual, room_id?, timestamp?}` with full validation (unknown student/room rejected, method normalised to the schema values). The scan is **idempotent**: a student is marked present at most once per calendar day, so RFID double-reads and rapid clicks return the existing row (`duplicate: true`) instead of a duplicate-looking feed entry. Two simulators exist and both post the exact same payload contract: `scripts/simulate-scanner.js` (interval-based background atmosphere; set `SCAN_METHOD=rfid` for an all-RFID demo) and the dashboard's **"Simulate RFID scan"** button, which always posts `method: "rfid"` with a random enrolled student and a live timestamp. The overview's attendance panel is a live feed of **today's** scans (newest first) that re-polls `/api/attendance/summary` every 5s — a physical reader hitting the same endpoint would appear there identically.
- **Staffing outlook** — `src/staffing-predictor.js` is a **clearly-labelled statistical heuristic**: it computes each class's historical absence rate on each weekday from real `attendance_records` and projects the shortfall per timetable slot, and cross-references subjects on the curriculum that no staff member is qualified to teach (the same signal the generator reports as unresolved).
- **Dashboard** — the attention queue renders from real `notifications` rows; Approve/Review/Fix/Generate buttons call real endpoints that update the database and re-run the scan. The timetable view now supports full manual editing (add / edit / delete any slot) alongside regeneration. The attendance panel is a live feed that re-polls `/api/attendance/summary` every 5s while visible.

---

## Security hardening

- **Helmet** security headers on every response (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS in production). Content-Security-Policy is intentionally off — the pages use inline scripts (no build step), and a strict policy would break them.
- **Login rate limiting** — 10 attempts/minute per IP on `POST /api/auth/login` (returns a clear 429). `trust proxy` is enabled in production so the limiter sees real client IPs behind Render's proxy.
- **Upload validation** — only images (JPEG/PNG/GIF/WebP) and PDFs are accepted (a phone-style generic-mime + known extension is tolerated); anything else gets a 400 with a clear message, and files over **15 MB** are rejected with 413.
- **`.env.example`** ships in the repo listing every environment variable with placeholder values — no real secrets, and the server/seed still refuse to run with a known default admin password.
- **Soft-delete roster** — deleting a student/staff/room flags it `inactive` instead of removing the row, so nothing orphans; the timetable, attendance scanner and form dropdown only ever see active entries, and the Data hub offers Restore.

---

## AI components — what is real AI vs classical logic

Honest breakdown for judges:

| Piece | Category | How it works |
|---|---|---|
| Document extraction | **Real LLM** | Vision-capable **Google Gemini** model (`generateContent`, `gemini-3.6-flash` by default, override with `GEMINI_MODEL`) reads the uploaded image/PDF and returns strict JSON (`responseMimeType: application/json`). All failures degrade gracefully to `needs_human_review` and are logged |
| Conflict detection | **Deterministic algorithm** | Pure rule-based scan of `timetable_slots` for staff/room double-bookings |
| Timetable generation | **Deterministic algorithm** | Dependency-free constraint-satisfaction solver (no LLM, no external solver) |
| Staffing predictions | **Statistical heuristic** | Rolling absence rates over real attendance history + unqualified-subject gaps — deliberately not an ML model |
| Attendance scans | **Ingestion** | Real rows written by the scan endpoint; the simulator script is demo hardware, the endpoint is the real path |

No displayed number is fabricated: stats, notifications, predictions, extraction results, and the generated timetable are all computed from the live database at request time. The only sample data lives in `db/seeds/dev-seed.js` (dev/demo only, guarded by `NODE_ENV=production`).

## Testing

```bash
npm test
```

Runs the full suite (`node --test "tests/**/*.test.js"`) against in-memory SQLite databases (route handlers are exercised over real HTTP via the shared `tests/helpers.js` harness — the only test double anywhere is a mocked Gemini client, plus stub-server tests that pin the exact Gemini wire format). Coverage: conflict detection (6), document extraction (parse / fence-stripping / fallback paths), forms upload→verify→corrected-data merge + retry-extract (including a full mocked-client success path), timetable generation (constraints + a cross-check that runs the *real* conflict detector over generated output), attendance scan validation, and staffing predictions.

---

## Notes for later

- **Sessions** are signed cookies (stateless, restart-safe). Swap for real session storage / Passport / roles when multi-admin comes. In production the server warns loudly if `SESSION_SECRET` is unset (a hardcoded dev-only secret is used locally).
- **Postgres migration** — the SQL is portable (only `AUTOINCREMENT`/`datetime('now')`/`?` placeholders are SQLite-flavoured). Swapping `src/db.js` for `pg` is a mechanical change.
- **Background scan** is a `setInterval` (every 60s + after every mutation) — for a long-running deployment run `runScan` as a cron job instead. The same scan is recorded in `/api/status` as `last_scan_at`.
- **Document extraction** calls Google Gemini directly over `fetch` — no SDK dependency. **Free-tier constraint (known, not coded around):** Gemini's free tier rate-limits the Flash models (roughly ~10–15 requests/minute and ~500–1,500 requests/day, resetting at midnight Pacific — exact numbers are per-project in AI Studio → Rate Limits). A live demo does a handful of uploads, so this never bites; just don't run bulk re-extraction loops. If you want batching/retries at scale, move it behind a small queue; for hackathon scope an in-process async call is enough and never blocks the upload response.
