# SchoolVerse

An AI-powered operations platform for schools — paperwork in, system out.

SchoolVerse replaces the manual admissions forms, disconnected spreadsheets, and reactive firefighting that most school offices run on with a single platform: an AI document reader that digitizes paper forms, a constraint-solving timetable generator that can't double-book a teacher or room, a dashboard that surfaces problems before an admin goes looking for them, and simulated RFID/CV attendance ingestion on the same API real hardware would use.

Built for [Hackathon Name] · [Team Name] · [Date]

Live demo: https://schoolverse-u7n5.onrender.com · Admin login: provided separately / see Judge Notes

## Table of contents

- [The problem](#the-problem)
- [What SchoolVerse does](#what-schoolverse-does)
- [AI components — what's real AI vs. classical logic](#ai-components--whats-real-ai-vs-classical-logic)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [API reference](#api-reference)
- [How the proactive pieces work](#how-the-proactive-pieces-work)
- [Security](#security)
- [Testing](#testing)
- [Deployment](#deployment)
- [Judge notes](#judge-notes)
- [Roadmap](#roadmap)

## The problem

Schools still run daily operations on paper and disconnected tools: admissions forms get retyped by hand, timetables are built in spreadsheets with double-bookings discovered on the first day of term, attendance is a manual roll call, and admins only find out something's wrong when someone walks in and tells them. SchoolVerse's mission is to digitize the paperwork, automate the scheduling, unify the data, and make the dashboard proactive instead of something admins have to interrogate.

## What SchoolVerse does

| Requirement | Status | How |
|---|---|---|
| AI Document Reader | ✅ Live | Uploaded admission forms / fee receipts / medical records are read by a real vision-capable LLM and extracted into structured fields for review |
| Smart Timetables | ✅ Live | A constraint-satisfaction solver generates a full weekly schedule with zero teacher/room double-bookings by construction; a full manual editor (add/edit/delete any slot) sits alongside it |
| All-in-One System | ✅ Live | Students, staff, rooms, timetable, attendance, fees, and uploaded forms live in one database and update in real time across the dashboard |
| Proactive Admin Dashboard | ✅ Live | An attention queue — clashes, pending reviews, staffing gaps, overdue fees — renders from real state and re-scans after every change; the dashboard's stat cards, queue, and feeds re-render through a small observable store, not a full-page refresh |
| Bonus: Smart Staffing | ✅ Live | A statistical heuristic projects staffing shortfalls from real attendance history and unqualified-subject gaps |
| Bonus: Auto-Attendance | ✅ Live | RFID/CV scan events post to a real ingestion endpoint and appear in a live-polling attendance feed; two simulators (a background script and a dashboard button) stand in for physical hardware, hitting the identical API contract a real reader would |

## AI components — what's real AI vs. classical logic

Being upfront about this matters for judging, so here's the honest breakdown:

| Piece | Category | Detail |
|---|---|---|
| Document extraction | Real LLM | Google Gemini (generateContent, vision-capable, JSON-mode response) reads the uploaded image/PDF and returns structured fields. Every failure degrades gracefully to a manual-review state — never a crash |
| Conflict detection | Deterministic algorithm | Rule-based scan of the timetable for staff/room double-bookings |
| Timetable generation | Deterministic algorithm | A dependency-free constraint-satisfaction solver (greedy MRV ordering + bounded backtracking) — no LLM, no external solver library |
| Staffing predictions | Statistical heuristic | Rolling absence rates over real attendance history, deliberately not framed as machine learning |
| Attendance scans | Ingestion | Real rows written by a validated API endpoint; the "hardware" is simulated, the endpoint and data path are production-real |

No number shown anywhere in the app is fabricated — stats, notifications, predictions, and the generated timetable are all computed from the live database at request time. The only non-live data is the local dev seed, which is explicitly blocked from running in production.

## Tech stack

- **Backend:** Node.js + Express
- **Database:** SQLite (better-sqlite3, WAL mode) — schema is portable SQL, a Postgres migration is a mechanical swap of the data-access layer
- **Frontend:** Vanilla HTML/CSS/JS, no build step — a small hand-rolled observable store drives reactive re-rendering on the dashboard
- **AI:** Google Gemini (gemini-3.6-flash) for document extraction, called directly over fetch with no SDK dependency
- **Auth:** Signed HMAC session cookies + bcrypt password hashing
- **Hosting:** Render (Node web service + free-tier ephemeral SQLite)
- **Testing:** Node's built-in test runner (node:test), exercised over real HTTP against in-memory databases

## Architecture

```
server.js                    Express entry — static serving, route mounting, auth guard, error handler, background scan
db/
  schema.sql                 All tables + indexes (portable SQL)
  migrate.js                 Idempotent schema runner
  seeds/dev-seed.js          Dev-only sample data (refuses to run in production)
src/
  db.js                      better-sqlite3 connection (WAL mode, FK enforcement)
  auth.js                    Signed-cookie sessions + bcrypt hashing
  conflict-detector.js       Timetable conflict detection (staff/room double-booking)
  notification-service.js    Generates notifications from real conflicts/forms/staffing gaps/overdue fees
  stats.js                   Real aggregate queries for the stats section
  document-extractor.js      LLM document extraction (Google Gemini)
  timetable-generator.js     Constraint-satisfaction timetable generator (backtracking)
  staffing-predictor.js      Statistical staffing-heuristic predictions
routes/                      /api/* handlers
scripts/simulate-scanner.js  Simulated RFID/CV hardware client
public/
  index.html                 Landing page (live data sections)
  dashboard.html             Dashboard app (post-login)
  login.html                 Sign-in
  styles.css / app.js        Shared token system + reactive store
tests/                       Full route + logic coverage, in-memory DB
```

## Quick start

Requires **Node 22.x** (pinned in `engines.node` and `render.yaml` — newer runtimes don't yet have a prebuilt binary for the SQLite driver).

```bash
npm install
SEED_ADMIN_EMAIL=admin@your-school.org SEED_ADMIN_PASSWORD='pick-a-strong-password' npm run setup
npm start
```

Then open:

| URL | What it is |
|---|---|
| http://localhost:3000/ | Landing page — marketing + live read-only data |
| http://localhost:3000/login.html | Admin sign-in |
| http://localhost:3000/dashboard.html | Dashboard app (redirects to login when signed out) |

```bash
npm run dev             # auto-restart on file change
npm test                # full test suite
npm run scan:simulate   # simulate RFID/CV attendance hardware
```

No default admin credentials are committed anywhere in this repo — the server refuses to seed or boot with demo data unless `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` are explicitly set.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `db/schoolverse.db` | SQLite file location |
| `SESSION_SECRET` | dev default | HMAC secret for session cookies — set a real value in production |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | required, no default | Admin credentials for the seeded account |
| `SEED_DEMO_ON_BOOT` | unset | `true` → seed demo data on boot when the DB is empty (used for ephemeral free-tier hosting) |
| `UPLOADS_DIR` | `public/uploads` | Uploaded form storage (point at a persistent disk in production) |
| `GEMINI_API_KEY` | unset | Free key from aistudio.google.com/apikey for live document extraction |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Override the extraction model per deployment |
| `BASE_URL` / `SCAN_INTERVAL_MS` / `SCAN_METHOD` | — | Config for `npm run scan:simulate` only |

## API reference

**Public**

| Method | Endpoint | Notes |
|---|---|---|
| GET | `/api/health` | Liveness check |
| GET | `/api/status` | Uptime, last scan, extraction queue counters |
| GET | `/api/stats` | Real aggregates |
| GET | `/api/timetable` | Weekly grid with conflict state |
| GET | `/api/notifications` | Open attention items |
| POST | `/api/auth/login` | Returns a session cookie |

**Authenticated (session cookie required)**

| Method | Endpoint | Notes |
|---|---|---|
| GET/POST | `/api/forms` | List / upload a form; extraction runs in the background |
| PATCH | `/api/forms/:id/verify` · `/reject` · `/retry-extract` | Review workflow |
| POST | `/api/timetable/generate` | Regenerate the whole timetable (destructive) |
| POST | `/api/timetable/slots` | Add a slot |
| PATCH/DELETE | `/api/timetable/slots/:id` | Full single-slot editor / delete |
| PATCH | `/api/notifications/:id/resolve` | Resolve an item |
| GET | `/api/attendance/summary` | Live feed source |
| POST | `/api/attendance/scan` | Real scan ingestion — idempotent per student per day |
| GET/POST/PATCH/DELETE | `/api/roster/students` · `/staff` · `/rooms` | Full CRUD, soft-delete + restore |
| GET | `/api/staffing/predictions` | Staffing outlook |

## How the proactive pieces work

- **Conflict detection** checks every slot for a shared teacher or room at the same day+period; reassigning a slot triggers a full rescan so peers clear automatically.
- **Notifications** are generated from real state — conflicts, pending reviews, low-confidence extractions, staffing gaps, and overdue fees — each with a fingerprint so repeated scans never spam duplicates, and recurring issues correctly re-open.
- **Document reader** calls Gemini directly, parses strict JSON into the extraction schema, and never crashes on a bad response — failures land in a review queue with the exact error visible in both the dashboard and the server logs.
- **Timetable generator** is a constraint solver over real curriculum/staffing input tables; anything it can't place becomes a staffing-gap notification instead of a silent failure.
- **Auto-attendance** posts to the same endpoint real RFID/CV hardware would use; the dashboard's live feed re-polls every 5 seconds.
- **Dashboard** re-renders reactively through a small observable store — each panel updates only when its own data changes, not on a full-page refresh.

## Security

- Helmet security headers on every response
- Login rate limiting (10 attempts/minute/IP)
- Upload validation — images and PDFs only, 15MB limit
- No committed credentials anywhere in the repo; `.env.example` documents every variable with placeholders only
- Soft-delete on all roster records — nothing orphans references in the timetable, attendance, or forms

## Testing

```bash
npm test
```

Runs the full suite against in-memory SQLite databases, exercising route handlers over real HTTP. Covers conflict detection, document extraction (including a mocked-LLM success path and real wire-format stub tests), the full forms upload→verify lifecycle, timetable generation and its manual-edit routes, attendance scan validation, roster CRUD with fee-status notifications, staffing predictions, and the dashboard's reactive store.

## Deployment

Live on Render via the included `render.yaml` blueprint — connect the repo, supply `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` when prompted, and deploy. Full walkthrough and free-tier persistence tradeoffs are documented inline in `render.yaml`.

**Free-tier note:** Render's free instances have an ephemeral filesystem and spin down after ~15 minutes of inactivity. SchoolVerse re-seeds a fresh demo database on every boot, so the app always looks alive — but anything entered through the dashboard during a session resets when it idles out. This is a deliberate tradeoff for a $0 hackathon deployment; the codebase is disk-persistence-ready for a paid instance (see comments in `render.yaml`).

## Judge notes

- If the site has been idle, the first request may take 30–50 seconds to wake up — this is Render's free-tier cold start, not a bug.
- Data resets to the seeded demo state after ~15 minutes of inactivity, by design (see Deployment).
- Document extraction requires a `GEMINI_API_KEY` to be configured on the live instance; without it, uploads still work end-to-end but land in manual review instead of an AI-extracted state.
- Everything under *What SchoolVerse does* is tested live, not just implemented — see the AI components table for exactly what's a real model call versus deterministic logic.

## Roadmap

- Fee ledger / payment history beyond the current status field
- Multi-admin roles and permissions
- Postgres migration for persistent, multi-writer production use
- Batched/queued document extraction for bulk uploads beyond the free-tier rate limit
