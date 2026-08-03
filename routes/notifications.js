'use strict';
const express = require('express');

const router = express.Router();

// GET /api/notifications?include_resolved=0&limit=4
// Public read-only with a small payload so the landing preview is honest.
router.get('/', (req, res) => {
  const includeResolved = req.query.include_resolved === '1' || req.query.include_resolved === 'true';
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const where = includeResolved ? '' : 'WHERE resolved = 0';
  // True open size (ignores the LIMIT) so clients can show an honest
  // "X need attention" alongside the truncated preview list.
  const total = req.db.prepare(`SELECT COUNT(*) c FROM notifications ${where}`).get().c;
  // Rank open items by severity first (urgent clashes surface ahead of
  // warnings), then newest first — "issues surface, get ranked."
  const rows = req.db.prepare(`
    SELECT id, type, message, severity, resolved, created_at
      FROM notifications ${where}
     ORDER BY resolved ASC,
              CASE severity WHEN 'urgent' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
              created_at DESC, id DESC
     LIMIT ?`).all(limit);
  res.json({ notifications: rows, total });
});

// PATCH /api/notifications/:id/resolve  (authed)
router.patch('/:id/resolve', (req, res) => {
  const id = Number(req.params.id);
  const info = req.db.prepare(`UPDATE notifications SET resolved = 1 WHERE id = ? AND resolved = 0`)
    .run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'notification not found or already resolved' });
  const row = req.db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(id);
  res.json({ ok: true, notification: row });
});

module.exports = router;
