# Demo Flow — 4-Minute Run-Through (Day 7 rehearsal notes)

Warm the instance first: visit `https://schoolverse-u7n5.onrender.com/` and wait for
the first response (~30–50s cold start). Then keep a tab on `/dashboard.html` open —
the 60s background scan keeps the free instance awake.

## The flow (timed on a fresh seed, local)

| Step | What you do | What you should see | ~Time |
|---|---|---|---|
| 1 | Open landing page, scroll to "Four systems" | Cards fly in from the four corners (scroll-linked) | 10s |
| 2 | Log in as **admin** (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` from Render env) | Dashboard: **10 open items** — 2 clashes (urgent), 1 absence alert (Isha, 3 days), 2 staffing suggestions (one with "Accept suggestion"), 1 staffing gap, 1 overdue fee, 3 pending reviews | 15s |
| 3 | Forms tab → open Kabir's medical form | **Low OCR confidence (55%)** badge + extracted fields + Edit-before-verify form | 20s |
| 4 | Timetable tab → **Generate timetable** → confirm | Grid rebuilds; **0 conflicts, 0 unassigned**; new "generated gap" notifications appear for Social Studies (honest: no qualified teacher) | 20s |
| 5 | Make a real clash: edit any slot → move to a busy room/teacher | Cell turns **red "CLASH DETECTED"** instantly; queue gains the clash | 20s |
| 6 | Resolve it: use the clash cell's "Move to…" + **Fix** | Cell clears to AUTO-RESOLVED; clash notification auto-resolves on rescan | 15s |
| 7 | Overview → **Simulate RFID scan** (or `npm run scan:simulate`) | Live feed updates within 5s poll: "present — via RFID"; attendance auto-% ticks | 15s |
| 8 | Sign out → log in as **teacher** | Teacher console: own timetable (read-only), own students' attendance with **correct** dropdowns, alerts scoped to their students only (real low-conf reason visible) | 15s |
| 9 | Teacher: correct a student's attendance (mark present) | Row flips to **manual** method; if it clears a 3-day absence run the alert resolves | 10s |

Total ≈ **2 min 20 s** of active demo; leaves room for judge questions.

## Friction found & fixed on Day 7

- Teacher alerts showed a **generic "awaits review"** for low-confidence forms
  instead of the real reason the admin sees — fixed (pending_review rows now
  carry student_id; teacher route prefers real rows, falls back only for
  forms uploaded since the last scan, with no duplicates).

## Notes for judging

- **Cold start**: first hit after ~15 min idle takes 30–50s. Warm it before
  the session; the 60s background scan then keeps it awake.
- **Data reset**: free tier wipes the DB on spin-down/redeploy and re-seeds
  on boot — by design. Anything typed in during the demo persists only for
  that session.
- **Gemini**: uploads need `GEMINI_API_KEY`; without it forms land in manual
  review (graceful, by design). Free tier has rate limits — demo a small
  upload, not a bulk batch.
- **Backup video**: record this exact flow as a GIF/screen recording before
  judging day — live demo can always fail (network, key rate limit, cold
  start).
