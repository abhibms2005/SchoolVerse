'use strict';
// Applies db/schema.sql idempotently. Safe to run on every boot.
const fs = require('fs');
const path = require('path');
const { openDb, DB_PATH } = require('../src/db');

// SQLite's CREATE TABLE IF NOT EXISTS won't add columns to tables that
// already exist, so columns added after the first release get a guarded
// ALTER TABLE here — checked per-boot, no-op once present.
const ADD_COLUMNS = [
  ['rooms', 'room_type', "TEXT NOT NULL DEFAULT 'classroom'"],
  ['attendance_records', 'room_id', 'INTEGER REFERENCES rooms(id) ON DELETE SET NULL'],
  ['uploaded_forms', 'extraction_status', "TEXT NOT NULL DEFAULT 'pending'"],
  ['uploaded_forms', 'extraction_confidence', 'REAL'],
  // Soft-delete flags for roster CRUD (DELETE sets status='inactive' instead
  // of removing the row, so timetable slots / attendance / forms keep their
  // references intact).
  ['staff', 'status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))"],
  ['rooms', 'status', "TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))"],
  // Fee tracking on students (one field, not a payments system): paid /
  // pending / overdue. Overdue students surface as notifications.
  ['students', 'fee_status', "TEXT NOT NULL DEFAULT 'pending' CHECK (fee_status IN ('paid','pending','overdue'))"],
  // Multi-role platform: role (admin|teacher) + an optional link to a staff
  // row so a teacher account's scope derives from real timetable data.
  ['admins', 'role', "TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','teacher'))"],
  ['admins', 'staff_id', 'INTEGER REFERENCES staff(id) ON DELETE SET NULL'],
  // Notification refs: student_id scopes teacher views + absence alerts,
  // slot_id/staff_id let staffing-suggestion cards carry a one-click accept.
  ['notifications', 'student_id', 'INTEGER REFERENCES students(id) ON DELETE SET NULL'],
  ['notifications', 'slot_id', 'INTEGER REFERENCES timetable_slots(id) ON DELETE SET NULL'],
  ['notifications', 'staff_id', 'INTEGER REFERENCES staff(id) ON DELETE SET NULL'],
  // Fee ledger: expected yearly fee per student. 0 = manual fee_status mode
  // (the seeded flags stay authoritative); > 0 = balance-driven.
  ['students', 'expected_fee', 'REAL NOT NULL DEFAULT 0'],
];

function ensureColumns(db) {
  for (const [table, column, ddl] of ADD_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      console.log(`[migrate] added column ${table}.${column}`);
    }
  }
}

// The notifications table has evolved since first release: the type CHECK
// gained 'fee_overdue', then 'staffing_suggestion' + 'absence', and the table
// gained student_id/slot_id/staff_id ref columns. SQLite cannot ALTER a CHECK
// constraint, so when an older table definition is present we rebuild the
// table in place — every column that exists on the old table carries over
// (rows, ids and the fingerprint unique index), so no data is lost.
const NOTIF_REBUILD_MARKERS = ['fee_overdue', 'staffing_suggestion', 'absence', 'student_id'];
function rebuildNotificationsTable(db) {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`).get();
  if (!ddl) return; // table not yet created — schema.sql creates the current shape
  if (NOTIF_REBUILD_MARKERS.every((m) => ddl.sql.includes(m))) return; // already current
  const cols = db.prepare(`PRAGMA table_info(notifications)`).all().map((c) => c.name);
  const colList = cols.join(', ');
  db.exec(`
    CREATE TABLE notifications_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL CHECK (type IN ('clash', 'pending_review', 'staffing_gap', 'fee_overdue', 'staffing_suggestion', 'absence')),
      message     TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'warning'
        CHECK (severity IN ('urgent', 'warning', 'ok')),
      resolved    INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL UNIQUE,
      student_id  INTEGER REFERENCES students(id) ON DELETE SET NULL,
      slot_id     INTEGER REFERENCES timetable_slots(id) ON DELETE SET NULL,
      staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO notifications_new (${colList})
      SELECT ${colList} FROM notifications;
    DROP TABLE notifications;
    ALTER TABLE notifications_new RENAME TO notifications;
  `);
  console.log('[migrate] rebuilt notifications table (new types/ref columns)');
}

function migrate(db) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  ensureColumns(db);
  rebuildNotificationsTable(db);
}

if (require.main === module) {
  const db = openDb();
  migrate(db);
  console.log(`[migrate] schema applied to ${DB_PATH}`);
  db.close();
}

module.exports = { migrate };
