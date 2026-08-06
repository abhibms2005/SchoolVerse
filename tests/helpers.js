'use strict';
// Shared test helpers: an in-memory DB with the real schema (same pattern as
// tests/conflict-detector.test.js) and a way to mount a real Express router
// over HTTP so route logic is tested end-to-end with fetch (no extra deps).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const express = require('express');

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Mount a router on an ephemeral HTTP server behind a fake auth middleware
 * (sets req.admin like the real requireAuth would).
 * @param {express.Router} router
 * @param {string} [mountPath] path the router is mounted at, like the real
 *   server.js mounts (e.g. '/api/forms'). Defaults to '/api'.
 * @returns {Promise<{db, base, close}>}
 */
async function mountRouter(router, mountPath = '/api') {
  const db = makeDb();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.db = db; next(); });
  app.use(mountPath, (req, res, next) => { req.admin = { email: 'admin@test' }; next(); });
  app.use(mountPath, router);
  app.use(mountPath, (req, res) => res.status(404).json({ error: 'not found' }));
  // Mirror server.js's central error handler so route errors (e.g. multer
  // validation) surface as JSON, exactly as they do in production.
  app.use(mountPath, (err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: status >= 500 ? 'internal error' : (err.message || 'bad request') });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, base, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { makeDb, mountRouter };
