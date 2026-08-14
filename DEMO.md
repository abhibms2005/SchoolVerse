# Demo Flow — Judge Rehearsal Script

Warm the instance first: visit `https://schoolverse-u7n5.onrender.com/` and wait for
the first response (~30–50s cold start). Then keep a tab on `/dashboard.html` open —
the 60s background scan keeps the free instance awake.

## The flow (timed on a fresh seed, local)

| Step | What you do | What you should see | ~Time |
|---|---|---|---|
| 1 | Open the landing page | Live, honest preview sections (stats, timetable, notifications) — all fetched from the public API, none hardcoded | 10s |
| 2 | Log in as **admin** (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` from Render env) | Dashboard Overview: stat cards + "Recent notifications" queue (≈10 open items — clashes, Isha's absence alert, staffing suggestions, a staffing gap, an overdue fee, pending form reviews). **Mark resolved** clears an item via `PATCH /api/notifications/:id/resolve` | 15s |
| 3 | **Forms** tab → drag a real image/PDF into "Upload a physical form", pick a type + student → **Upload form** (`POST /api/forms`) | The Forms queue gains a row: "Extracting…" → confidence % (a real Gemini call; needs `GEMINI_API_KEY`) or a graceful manual-review state if the key is missing. Open the row → **Verify with these details** (`PATCH /api/forms/:id/verify`) or **Reject** (`PATCH /api/forms/:id/reject`). No `GEMINI_API_KEY`? Open Kabir's seeded medical form instead — it shows the real "low OCR confidence (55%)" badge | 30s |
| 4 | **Timetable** tab → **Generate timetable** → **Generate** in the confirm modal (`POST /api/timetable/generate`) | The seeded demo grid (curated: one room clash + one staffing gap) is replaced by the solver's real output — every section scheduled together under global teacher/room constraints; result banner "Slots placed / Unresolved / Conflicts" with **Conflicts: 0**; Social Studies gaps surface as staffing-gap notifications | 25s |
| 5 | Pick a different section in the **Section** dropdown | Only that section's grid re-renders (no page reload); add/edit slots via **+ Add slot** or a cell's **Edit** → **Save** (`POST /api/timetable/slots`, `PATCH /api/timetable/slots/:id/reassign`) | 15s |
| 6 | Force a real clash: **Edit** a cell → move it onto a busy room/teacher → **Save** | Cell flags **CLASH DETECTED** instantly; the queue gains the clash (urgent). Fix it: **Edit** the cell again → free room/teacher → **Save** → the clash clears and its notification auto-resolves on rescan | 20s |
| 7 | Overview → **Simulate RFID scan** (`POST /api/attendance/scan`, method `rfid`) | Live feed updates within the 5s poll: "RFID scan → \<student\> @ \<room\>"; "N scans today" ticks up; duplicate reads are ignored (idempotent) | 15s |
| 8 | **Notifications** tab → **Accept suggestion** on a staffing-suggestion card (reassigns via `PATCH /api/timetable/slots/:id/reassign`) | The slot is reassigned to the named qualified teacher; the suggestion clears on the next render | 15s |
| 9 | **Sign out** → sign in at `/login.html` with the teacher account (`SEED_TEACHER_EMAIL`/`SEED_TEACHER_PASSWORD`) | Teacher console: "My weekly timetable" (read-only, only this teacher's slots), "My students' attendance" with one-click **P / A / L** correction buttons, "Alerts for my students" (scoped to their students only) | 15s |
| 10 | Teacher: click **A** (or P/L) on a student's correction row | Row flips to the chosen status (method `manual`); if it ends a 3-day absence run, the absence alert resolves | 10s |

Total ≈ **2 min 50 s** of active demo; leaves room for judge questions.

## Friction found & fixed

- Teacher alerts showed a **generic "awaits review"** for low-confidence forms
  instead of the real reason the admin sees — fixed (pending_review rows now
  carry student_id; the teacher route prefers real rows and falls back only
  for forms uploaded since the last scan, with no duplicates).
- The old per-row **dropdown + Save** attendance correction is gone — replaced
  by one-click **P / A / L** buttons (same PATCH endpoint, no confirm step).

## Notes for judging

- **Cold start**: first hit after ~15 min idle takes 30–50s. Warm it before
  the session; the 60s background scan then keeps it awake.
- **Data reset**: free tier wipes the DB on spin-down/redeploy and re-seeds
  on boot — by design. Anything typed in during the demo persists only for
  that session.
- **Gemini**: uploads need `GEMINI_API_KEY`; without it forms land in manual
  review (graceful, by design). Free tier has rate limits — demo a small
  upload, not a bulk batch. Verify the key works on the live instance with a
  real upload before judging.
- **Teacher login**: only exists if `SEED_TEACHER_EMAIL` / `SEED_TEACHER_PASSWORD`
  are set in Render env; without them, skip steps 9–10.
- **Backup video**: record this exact flow as a GIF/screen recording before
  judging day — live demo can always fail (network, key rate limit, cold
  start).
