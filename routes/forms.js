'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const { upsertNotification } = require('../src/notification-service');

const router = express.Router();

// Uploads land in UPLOADS_DIR (configurable for persistent disks in
// production; defaults to public/uploads).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `form-${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// GET /api/forms?status=pending_review — list with student names (authed)
router.get('/', (req, res) => {
  const status = req.query.status;
  let where = '';
  const params = [];
  if (status) { where = 'WHERE f.status = ?'; params.push(status); }
  const rows = req.db.prepare(`
    SELECT f.id, f.form_type, f.file_path, f.status, f.uploaded_at, f.extracted_data,
           s.name AS student_name, s.class AS student_class
      FROM uploaded_forms f
      LEFT JOIN students s ON s.id = f.student_id
      ${where}
     ORDER BY f.uploaded_at DESC
     LIMIT 100`).all(...params);
  res.json({ forms: rows });
});

// POST /api/forms — upload a physical form (authed). OCR extraction is a
// TODO stub for now; the upload → DB flow is real.
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded (field name: file)' });

  const form_type = req.body.form_type || 'admission';
  const student_id = req.body.student_id ? Number(req.body.student_id) : null;
  const filePath = `uploads/${req.file.filename}`;

  const info = req.db.prepare(
    `INSERT INTO uploaded_forms (student_id, form_type, file_path, extracted_data, status)
     VALUES (?, ?, ?, NULL, 'pending_review')`
  ).run(student_id, form_type, filePath);

  upsertNotification(req.db, {
    type: 'pending_review',
    message: `${form_type} form uploaded${student_id ? ` (student #${student_id})` : ''} — awaiting review`,
    severity: 'warning',
    fingerprint: `pending_form_${info.lastInsertRowid}`,
  });

  const row = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, form: row });
});

// PATCH /api/forms/:id/verify — approve a pending form (authed)
router.patch('/:id/verify', (req, res) => {
  const id = Number(req.params.id);
  const info = req.db.prepare(`UPDATE uploaded_forms SET status = 'verified' WHERE id = ? AND status = 'pending_review'`)
    .run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'form not found or not pending' });

  // Mark its notification resolved.
  req.db.prepare(
    `UPDATE notifications SET resolved = 1 WHERE type = 'pending_review' AND fingerprint = ?`
  ).run(`pending_form_${id}`);

  const row = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  res.json({ ok: true, form: row });
});

// PATCH /api/forms/:id/reject — reject a pending form (authed)
router.patch('/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const info = req.db.prepare(`UPDATE uploaded_forms SET status = 'rejected' WHERE id = ? AND status = 'pending_review'`)
    .run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'form not found or not pending' });

  // Its review notification no longer applies.
  req.db.prepare(
    `UPDATE notifications SET resolved = 1 WHERE type = 'pending_review' AND fingerprint = ?`
  ).run(`pending_form_${id}`);

  const row = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  res.json({ ok: true, form: row });
});

module.exports = router;
