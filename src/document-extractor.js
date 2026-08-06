'use strict';
// Real document extraction for uploaded forms (images or PDFs) via Google's
// Gemini API (generateContent endpoint). The file is base64-encoded and sent
// as an inline_data part; the model is prompted to return strict JSON matching
// the extraction schema below. Uses the free-tier-eligible Flash models by
// default; no SDK dependency — plain fetch.
//
// Every failure path returns { ok:false, error } — this module never throws.
// Callers (routes/forms.js) persist that as a 'failed' extraction that still
// requires human review, so a bad scan can never crash the upload flow.
const fs = require('fs');
const path = require('path');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Configurable so deployments can point at any Gemini model without a code
// change. Defaults to gemini-2.5-flash (stable, proven, free-tier Flash).
// gemini-3.6-flash is the current latest stable Flash if you want the newest.
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const FORM_TYPES = ['admission', 'leave_request', 'fee_receipt', 'medical', 'other'];

const PROMPT = `You are a school records digitisation engine. You are given a photograph or scan of a physical school form (admission form, leave request, fee receipt, medical record, or other).

Extract the information and return ONLY a single JSON object with EXACTLY this shape — no markdown fences, no commentary, no extra text:

{
  "form_type": "admission" | "leave_request" | "fee_receipt" | "medical" | "other",
  "student_name": "full name or null if not found",
  "student_id": "id as string or null if not found",
  "date": "ISO date YYYY-MM-DD or null if not found",
  "fields": { "label": "value" },
  "confidence": 0.0,
  "needs_human_review": true or false
}

Rules:
- "fields" holds every other useful key/value you can read (amounts, class, guardian, condition, dates, signatures…). Use the label printed on the form as the key.
- "confidence" is 0..1: how sure you are the extraction is correct. Be conservative — messy handwriting, blur, or angle should lower it.
- "needs_human_review" must be true when the image is unclear, fields are missing, the form type is ambiguous, or confidence is low.
- If the document is not a school form at all, return form_type "other", empty fields, low confidence, and needs_human_review true.
- Never invent values that are not visible in the document. Prefer null over a guess.`;

function mediaTypeFor(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg'; // .jpg/.jpeg and anything unknown
}

/**
 * Parse + validate the model's text reply into the extraction schema.
 * Strips ```json fences if the model wrapped its answer, throws on
 * malformed JSON so callers can fall back to needs_human_review.
 * @param {string} text
 * @returns {object} normalized extraction record
 */
function parseExtractionResponse(text) {
  let raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) raw = fenced[1].trim();
  if (!raw) throw new Error('empty model response');

  const data = JSON.parse(raw); // throws on malformed JSON
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('model returned non-object JSON');
  }

  const confidence = Math.min(1, Math.max(0, Number(data.confidence) || 0));
  return {
    form_type: FORM_TYPES.includes(data.form_type) ? data.form_type : 'other',
    student_name: typeof data.student_name === 'string' ? data.student_name : null,
    student_id: typeof data.student_id === 'string' ? data.student_id : null,
    date: typeof data.date === 'string' ? data.date : null,
    fields: data.fields && typeof data.fields === 'object' && !Array.isArray(data.fields) ? data.fields : {},
    confidence,
    needs_human_review: Boolean(data.needs_human_review) || confidence < 0.6,
  };
}

/**
 * The real Gemini generateContent HTTP client. Injectable so unit tests never
 * hit the API. `apiUrl` lets tests point at a stub server.
 */
async function geminiClient({ apiKey, model, mediaType, base64, prompt, timeoutMs, apiUrl = API_BASE }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${apiUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mediaType, data: base64 } },
            { text: prompt },
          ],
        }],
        // Ask Gemini to return raw JSON — the strict-JSON prompt + fence
        // stripping remain as belt-and-braces.
        // 2048 tokens of headroom so a dense form (many fields) never has its
        // JSON reply truncated mid-object by the output cap.
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 2048 },
      }),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.error && json.error.message) || `Gemini API ${res.status}`;
      throw new Error(String(msg).slice(0, 200));
    }
    const text = (json.candidates || [])
      .map((c) => (c.content && c.content.parts) || [])
      .flat()
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
    if (!text) throw new Error('Gemini returned no text content');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract structured data from an uploaded document.
 * @param {string} filePath absolute path to the uploaded file
 * @param {object} [opts] { apiKey, model, client, timeoutMs, apiUrl } — client
 *   is the HTTP function (defaults to the real Gemini call); injectable for
 *   tests, which is how unit tests mock Gemini's response shape.
 * @returns {Promise<{ok:true, data:object}|{ok:false, error:string}>}
 */
async function extractDocument(filePath, opts = {}) {
  if (!filePath) return { ok: false, error: 'no file path provided' };

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, error: `could not read uploaded file: ${err.message}` };
  }

  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'GEMINI_API_KEY not configured — extraction skipped, form queued for manual review' };
  }

  const client = opts.client || geminiClient;
  try {
    const text = await client({
      apiKey,
      model: opts.model || MODEL,
      mediaType: mediaTypeFor(filePath),
      base64: buffer.toString('base64'),
      prompt: PROMPT,
      timeoutMs: opts.timeoutMs || 45000,
      apiUrl: opts.apiUrl,
    });
    const data = parseExtractionResponse(text);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { extractDocument, parseExtractionResponse, geminiClient, PROMPT };
