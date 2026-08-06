'use strict';
// Simulated attendance hardware — posts realistic scan events to the REAL
// ingestion endpoint (POST /api/attendance/scan) on an interval. This is only
// for demo atmosphere: a real RFID reader / CV camera would hit the same
// endpoint, so the ingestion path exercised here is the genuine one.
//
// Usage (against the running app):
//   BASE_URL=http://localhost:3000 \
//   SEED_ADMIN_EMAIL=admin@your-school.org SEED_ADMIN_PASSWORD='...' \
//   SCAN_INTERVAL_MS=4000 \
//   node scripts/simulate-scanner.js
//
// It logs in as the admin (to obtain a session cookie), fetches the real
// roster + rooms, then scans a random student at a random room each tick.

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 4000;
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const METHODS = ['rfid', 'rfid', 'cv', 'manual']; // weighted like a real school

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required (the scanner logs in to ingest scans)');
  }

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status}) — is the app running at ${BASE}?`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const studentsRes = await fetch(`${BASE}/api/roster/students`, { headers: { cookie } });
  const roomsRes = await fetch(`${BASE}/api/roster/rooms`, { headers: { cookie } });
  const { students } = await studentsRes.json();
  const { rooms } = await roomsRes.json();
  if (!students.length || !rooms.length) {
    throw new Error('no students or rooms in the roster — seed the database first');
  }

  console.log(`[scanner] connected to ${BASE} — ${students.length} students, ${rooms.length} rooms, tick ${INTERVAL_MS}ms`);

  const tick = async () => {
    const payload = {
      student_id: pick(students).id,
      method: pick(METHODS),
      room_id: pick(rooms).id,
      timestamp: new Date().toISOString(),
    };
    try {
      const res = await fetch(`${BASE}/api/attendance/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${body.error || ''}`);
      console.log(`[scanner] ${payload.timestamp} ${payload.method.toUpperCase()} → ${body.attendance.student_name} @ ${body.attendance.room_name || 'no room'} (row #${body.attendance.id})`);
    } catch (err) {
      console.error(`[scanner] scan failed: ${err.message}`);
    }
  };

  await tick(); // one immediately, then on the interval
  setInterval(tick, INTERVAL_MS);
}

main().catch((err) => {
  console.error(`[scanner] ${err.message}`);
  process.exit(1);
});
