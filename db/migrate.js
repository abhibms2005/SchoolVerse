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

// The notifications.type CHECK gained a new value ('fee_overdue'). SQLite
// cannot ALTER a CHECK constraint, so when an older table definition is
// present we rebuild the table in place — rows, ids and the fingerprint
// unique index all carry over, so no data is lost.
function rebuildNotificationsTable(db) {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'`).get();
  if (!ddl || /fee_overdue/.test(ddl.sql)) return; // already current (or table not yet created)
  db.exec(`
    CREATE TABLE notifications_new (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL CHECK (type IN ('clash', 'pending_review', 'staffing_gap', 'fee_overdue')),
      message     TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'warning'
        CHECK (severity IN ('urgent', 'warning', 'ok')),
      resolved    INTEGER NOT NULL DEFAULT 0,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO notifications_new (id, type, message, severity, resolved, fingerprint, created_at)
      SELECT id, type, message, severity, resolved, fingerprint, created_at FROM notifications;
    DROP TABLE notifications;
    ALTER TABLE notifications_new RENAME TO notifications;
  `);
  console.log('[migrate] rebuilt notifications table (fee_overdue type added)');
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
