'use strict';
// Applies db/schema.sql idempotently. Safe to run on every boot.
const fs = require('fs');
const path = require('path');
const { openDb, DB_PATH } = require('../src/db');

function migrate(db) {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

if (require.main === module) {
  const db = openDb();
  migrate(db);
  console.log(`[migrate] schema applied to ${DB_PATH}`);
  db.close();
}

module.exports = { migrate };
