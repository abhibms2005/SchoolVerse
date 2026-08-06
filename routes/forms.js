'use strict';
const express = require('express');
const path = require('path');
const multer = require('multer');
const { upsertNotification, runScan } = require('../src/notification-service');
const { extractDocument } = require('../src/document-extractor');

const router = express.Router();

// Test hook: lets unit tests inject a fake model client so background
// extraction can be exercised without the network. null (the default) means
// extractDocument uses its real Gemini client.
let _extractClient = null;
function _setExtractClient(fn) { _extractClient = fn; }

// Uploads land in UPLOADS_DIR (configurable for persistent disks in
// production; defaults to public/uploads).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');

// Only images and PDFs are accepted as form scans. Phones sometimes send a
// generic application/octet-stream with a proper extension, so accept a real
// image/PDF mime type OR (generic mime + known extension). Everything else
// gets a clear 400 — never a silent write.
const MIME_OK = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const EXT_OK = /\.(jpe?g|png|gif|webp|pdf)$/i;
function fileFilter(req, file, cb) {
  const generic = !file.mimetype || file.mimetype === 'application/octet-stream';
  if (MIME_OK.has(file.mimetype) || (generic && EXT_OK.test(file.originalname))) return cb(null, true);
  const err = new Error('only image (JPEG/PNG/GIF/WebP) and PDF uploads are allowed');
  err.status = 400;
  cb(err);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
      cb(null, `form-${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter,
});

// GET /api/forms?status=pending_review — list with student names (authed)
router.get('/', (req, res) => {
  const status = req.query.status;
  let where = '';
  const params = [];
  if (status) { where = 'WHERE f.status = ?'; params.push(status); }
  const rows = req.db.prepare(`
    SELECT f.id, f.form_type, f.file_path, f.status, f.uploaded_at, f.extracted_data,
           f.extraction_status, f.extraction_confidence,
           s.name AS student_name, s.class AS student_class
      FROM uploaded_forms f
      LEFT JOIN students s ON s.id = f.student_id
      ${where}
     ORDER BY f.uploaded_at DESC
     LIMIT 100`).all(...params);
  res.json({ forms: rows });
});

/**
 * Run extraction in the background for a freshly uploaded form. Responds
 * immediately with the pending row; this updates extracted_data and flips
 * extraction_status when the model reply lands. Every path is caught — a
 * failed extraction marks the row 'failed' (still pending_review, with the
 * error surfaced) and never crashes the server.
 */
function extractInBackground(db, formId, absPath) {
  const markFailed = (error) => {
    try {
      db.prepare(
        `UPDATE uploaded_forms
            SET extracted_data = ?, extraction_status = 'failed'
          WHERE id = ? AND extraction_status = 'pending'`
      ).run(JSON.stringify({ needs_human_review: true, extraction_error: String(error) }), formId);
    } catch (err) {
      console.error('[forms] failed to record extraction failure:', err);
    }
  };

  extractDocument(absPath, { apiKey: process.env.GEMINI_API_KEY, client: _extractClient })
    .then((result) => {
      if (result.ok) {
        db.prepare(
          `UPDATE uploaded_forms
              SET extracted_data = ?, extraction_status = 'done', extraction_confidence = ?
            WHERE id = ?`
        ).run(JSON.stringify(result.data), result.data.confidence, formId);
      } else {
        markFailed(result.error);
        return;
      }
      // Refresh notifications (pending_form + low-confidence reason) and the
      // /api/status extraction counters. Guarded separately: a scan hiccup
      // after a SUCCESSFUL extraction must never overwrite the good result.
      try {
        runScan(db);
      } catch (err) {
        console.error('[forms] notification refresh after extraction failed:', err);
      }
    })
    .catch((err) => markFailed(err && err.message ? err.message : err));
}

// POST /api/forms — upload a physical form (authed). The upload → DB flow is
// synchronous and real; OCR extraction runs in the background and updates the
// same row when it finishes.
router.post('/', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded (field name: file)' });

  const form_type = req.body.form_type || 'admission';
  const student_id = req.body.student_id ? Number(req.body.student_id) : null;
  const filePath = `uploads/${req.file.filename}`;

  const info = req.db.prepare(
    `INSERT INTO uploaded_forms (student_id, form_type, file_path, extracted_data, extraction_status, status)
     VALUES (?, ?, ?, NULL, 'pending', 'pending_review')`
  ).run(student_id, form_type, filePath);

  upsertNotification(req.db, {
    type: 'pending_review',
    message: `${form_type} form uploaded${student_id ? ` (student #${student_id})` : ''} — awaiting review`,
    severity: 'warning',
    fingerprint: `pending_form_${info.lastInsertRowid}`,
  });

  const row = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, form: row });

  // Fire-and-forget extraction — response already sent, never awaited.
  const absPath = path.join(UPLOADS_DIR, req.file.filename);
  setImmediate(() => extractInBackground(req.db, info.lastInsertRowid, absPath));
});

// PATCH /api/forms/:id/verify — approve a pending form (authed). Accepts an
// optional corrected_data object: when the admin edits the extracted fields
// before confirming, that object becomes the final extracted_data (the model's
// output is only ever overwritten by an explicit admin edit).
router.patch('/:id/verify', (req, res) => {
  const id = Number(req.params.id);
  const corrected = req.body && req.body.corrected_data;

  if (corrected !== undefined) {
    if (!corrected || typeof corrected !== 'object' || Array.isArray(corrected)) {
      return res.status(400).json({ error: 'corrected_data must be a JSON object' });
    }
    const confidence = Number(corrected.confidence);
    const first = req.db.prepare(
      `UPDATE uploaded_forms
          SET extracted_data = ?, extraction_status = 'done',
              extraction_confidence = COALESCE(?, extraction_confidence)
        WHERE id = ? AND status = 'pending_review'`
    ).run(JSON.stringify(corrected), Number.isFinite(confidence) ? confidence : null, id);
    if (first.changes === 0) return res.status(404).json({ error: 'form not found or not pending' });
  }

  const info = req.db.prepare(`UPDATE uploaded_forms SET status = 'verified' WHERE id = ? AND status = 'pending_review'`)
    .run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'form not found or not pending' });

  // Mark its notifications resolved (pending + low-confidence fingerprints).
  req.db.prepare(
    `UPDATE notifications SET resolved = 1 WHERE type = 'pending_review' AND fingerprint IN (?, ?)`
  ).run(`pending_form_${id}`, `low_conf_form_${id}`);

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

// PATCH /api/forms/:id/retry-extract — re-run document extraction for a form
// stuck in 'pending' (e.g. the process died mid-call and the row never
// resolved) or 'failed'. Resets the row and kicks off the same background
// extractor; responds immediately. Never re-runs over a completed extraction
// or a form that has already been verified/rejected.
router.patch('/:id/retry-extract', (req, res) => {
  const id = Number(req.params.id);
  const form = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  if (!form) return res.status(404).json({ error: 'form not found' });
  if (form.status !== 'pending_review') {
    return res.status(409).json({ error: 'form is not awaiting review' });
  }
  if (form.extraction_status === 'done') {
    return res.status(409).json({ error: 'form already extracted — nothing to retry' });
  }

  // Back to a clean 'pending': clear the stale failure blob so the UI shows
  // "Extracting…" again while the re-run is in flight. The guard makes a retry
  // that races a concurrent completion a clean no-op instead of wiping a fresh
  // 'done' result back to 'pending'.
  const reset = req.db.prepare(
    `UPDATE uploaded_forms SET extraction_status = 'pending', extracted_data = NULL, extraction_confidence = NULL
      WHERE id = ? AND extraction_status IN ('pending', 'failed')`
  ).run(id);
  if (reset.changes === 0) {
    return res.status(409).json({ error: 'form already extracted — nothing to retry' });
  }

  const row = req.db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  res.json({ ok: true, form: row });

  // Locate the stored file from file_path (uploads/<name>) and re-run.
  const filename = String(form.file_path || '').split('/').pop();
  if (!filename) {
    console.error(`[forms] retry ${id}: no file path on record`);
    return;
  }
  setImmediate(() => extractInBackground(req.db, id, path.join(UPLOADS_DIR, filename)));
});

module.exports = router;
module.exports._setExtractClient = _setExtractClient;
