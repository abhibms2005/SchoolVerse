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

function migrate(db) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  ensureColumns(db);
}

if (require.main === module) {
  const db = openDb();
  migrate(db);
  console.log(`[migrate] schema applied to ${DB_PATH}`);
  db.close();
}

module.exports = { migrate };
