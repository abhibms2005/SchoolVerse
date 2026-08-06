'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeDb, mountRouter } = require('./helpers');
const FORMS = '/api/forms';

// Retry tests re-run background extraction, which reads the stored file off
// disk — point the router's UPLOADS_DIR at a temp dir BEFORE it is required
// (module cache binds the env at require time) and drop a real file there.
const UPLOADS_TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-forms-up-'));
process.env.UPLOADS_DIR = UPLOADS_TEST_DIR;
fs.writeFileSync(path.join(UPLOADS_TEST_DIR, 'test.pdf'), 'fake pdf contents');

function seedPendingForm(db, { extracted = null, extraction_status = 'pending', confidence = null } = {}) {
  db.prepare(`INSERT INTO students (name, class) VALUES ('Aarav Sharma', '9B')`).run();
  const info = db.prepare(
    `INSERT INTO uploaded_forms (student_id, form_type, file_path, extracted_data, extraction_status, extraction_confidence, status)
     VALUES (1, 'admission', 'uploads/test.pdf', ?, ?, ?, 'pending_review')`
  ).run(extracted, extraction_status, confidence);
  return info.lastInsertRowid;
}

test('PATCH /api/forms/:id/verify stores corrected_data as the final extraction', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);

  const id = seedPendingForm(db, {
    extracted: JSON.stringify({ form_type: 'admission', student_name: 'Aarav Shrma', confidence: 0.55, needs_human_review: true }),
    extraction_status: 'done',
    confidence: 0.55,
  });

  const res = await fetch(`${base}${FORMS}/${id}/verify`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      corrected_data: {
        form_type: 'admission',
        student_name: 'Aarav Sharma',
        fields: { class: '9B', guardian: '+91 98100 11111' },
        confidence: 0.98,
        needs_human_review: false,
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.form.status, 'verified');

  const row = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  const stored = JSON.parse(row.extracted_data);
  assert.equal(stored.student_name, 'Aarav Sharma', 'admin correction wins over model output');
  assert.equal(stored.fields.guardian, '+91 98100 11111');
  assert.equal(row.extraction_confidence, 0.98);
  assert.equal(row.extraction_status, 'done');
});

test('verify without corrected_data keeps the model extraction untouched', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);

  const id = seedPendingForm(db, {
    extracted: JSON.stringify({ form_type: 'admission', student_name: 'Aarav Sharma', confidence: 0.9 }),
    extraction_status: 'done',
    confidence: 0.9,
  });

  const res = await fetch(`${base}${FORMS}/${id}/verify`, { method: 'PATCH' });
  assert.equal(res.status, 200);
  const row = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  const stored = JSON.parse(row.extracted_data);
  assert.equal(stored.student_name, 'Aarav Sharma');
  assert.equal(row.extraction_confidence, 0.9);
});

test('verify rejects corrected_data that is not an object', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);
  const id = seedPendingForm(db);
  const res = await fetch(`${base}${FORMS}/${id}/verify`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ corrected_data: 'not-an-object' }),
  });
  assert.equal(res.status, 400);
});

test('GET /api/forms exposes extraction_status and extraction_confidence', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);
  seedPendingForm(db, { extracted: '{}', extraction_status: 'done', confidence: 0.83 });

  const res = await fetch(`${base}${FORMS}`);
  assert.equal(res.status, 200);
  const { forms } = await res.json();
  assert.equal(forms.length, 1);
  assert.equal(forms[0].extraction_status, 'done');
  assert.equal(forms[0].extraction_confidence, 0.83);
});

test('PATCH /api/forms/:id/retry-extract resets a failed form and re-runs extraction', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);
  const id = seedPendingForm(db, {
    extracted: JSON.stringify({ needs_human_review: true, extraction_error: 'GEMINI_API_KEY not configured' }),
    extraction_status: 'failed',
  });

  const res = await fetch(`${base}${FORMS}/${id}/retry-extract`, { method: 'PATCH' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.form.extraction_status, 'pending', 'route resets the row for a fresh run');
  assert.equal(body.form.extracted_data, null, 'stale failure blob is cleared');

  // Without an API key the re-run fails fast back to 'failed' — the row is
  // never stranded in 'pending'.
  await new Promise((r) => setTimeout(r, 300));
  let row = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  assert.equal(row.extraction_status, 'failed');
  assert.equal(row.status, 'pending_review', 'still in the review queue');
  const stored = JSON.parse(row.extracted_data);
  assert.equal(stored.needs_human_review, true);
  assert.ok(stored.extraction_error);
});

test('retry-extract completes a successful extraction (mocked model client)', async (t) => {
  const formsRouter = require('../routes/forms');
  // extractDocument only reaches the (mocked) client when a key is present —
  // the key check runs before the client call.
  process.env.GEMINI_API_KEY = 'test-key';
  formsRouter._setExtractClient(async () =>
    '{"form_type":"fee_receipt","student_name":"Rohan Verma","student_id":"SV-0003","confidence":0.91,"fields":{"amount":"42500"},"needs_human_review":false}');
  t.after(() => {
    delete process.env.GEMINI_API_KEY;
    formsRouter._setExtractClient(null);
  });

  const { db, base, close } = await mountRouter(formsRouter, FORMS);
  t.after(close);
  const id = seedPendingForm(db, { extracted: '{}', extraction_status: 'failed' });

  const res = await fetch(`${base}${FORMS}/${id}/retry-extract`, { method: 'PATCH' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.form.extraction_status, 'pending');

  // Poll until the background extraction lands.
  let row = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  for (let i = 0; i < 30 && row.extraction_status === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    row = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  }
  assert.equal(row.extraction_status, 'done', 're-run completes');
  assert.equal(row.extraction_confidence, 0.91);
  const data = JSON.parse(row.extracted_data);
  assert.equal(data.student_name, 'Rohan Verma');
  assert.equal(data.fields.amount, '42500');
  assert.equal(row.status, 'pending_review');
});

test('retry-extract guards: 404 missing, 409 verified, 409 already done', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);

  let res = await fetch(`${base}${FORMS}/999/retry-extract`, { method: 'PATCH' });
  assert.equal(res.status, 404);

  const verifiedId = seedPendingForm(db, { extraction_status: 'done', confidence: 0.9, extracted: '{}' });
  db.prepare(`UPDATE uploaded_forms SET status = 'verified' WHERE id = ?`).run(verifiedId);
  res = await fetch(`${base}${FORMS}/${verifiedId}/retry-extract`, { method: 'PATCH' });
  assert.equal(res.status, 409);

  const doneId = seedPendingForm(db, { extraction_status: 'done', confidence: 0.9, extracted: '{}' });
  res = await fetch(`${base}${FORMS}/${doneId}/retry-extract`, { method: 'PATCH' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /already extracted/);
});

test('upload rejects non-image/PDF files with a clear 400, accepts generic-mime images', async (t) => {
  const { db, base, close } = await mountRouter(require('../routes/forms'), FORMS);
  t.after(close);

  // A .txt with a text/plain mime type is refused outright.
  const fd = new FormData();
  fd.append('file', new Blob(['not a form'], { type: 'text/plain' }), 'notes.txt');
  fd.append('form_type', 'admission');
  let res = await fetch(`${base}${FORMS}`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /only image/);

  // A phone-style upload (generic octet-stream mime + .jpg extension) is fine.
  const fd2 = new FormData();
  fd2.append('file', new Blob(['jpeg-bytes'], { type: 'application/octet-stream' }), 'scan.jpg');
  res = await fetch(`${base}${FORMS}`, { method: 'POST', body: fd2 });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).form.form_type, 'admission');
});

test('upload failure path: extraction cleanup marks a form failed, never stuck in pending', async () => {
  // Simulate the background extractor's failure branch against a real row.
  const db = makeDb();
  const id = seedPendingForm(db);
  const rowBefore = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  assert.equal(rowBefore.extraction_status, 'pending');

  db.prepare(`UPDATE uploaded_forms SET extracted_data = ?, extraction_status = 'failed' WHERE id = ?`)
    .run(JSON.stringify({ needs_human_review: true, extraction_error: 'GEMINI_API_KEY not configured' }), id);

  const rowAfter = db.prepare(`SELECT * FROM uploaded_forms WHERE id = ?`).get(id);
  assert.equal(rowAfter.extraction_status, 'failed');
  assert.equal(rowAfter.status, 'pending_review', 'form stays in the review queue');
  const stored = JSON.parse(rowAfter.extracted_data);
  assert.equal(stored.needs_human_review, true);
  assert.ok(stored.extraction_error);
  db.close();
});
