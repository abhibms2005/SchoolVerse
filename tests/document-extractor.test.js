'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { extractDocument, parseExtractionResponse, geminiClient } = require('../src/document-extractor');

// A stub Gemini server: asserts the request the client sends and replies with
// whatever Gemini-shaped JSON the test wants — no network, no key needed.
function stubGeminiServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const mockClient = (replyText) => async () => replyText;

function tmpFile(contents, ext = '.jpg') {
  const file = path.join(os.tmpdir(), `sv-doc-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(file, contents);
  return file;
}

test('parseExtractionResponse strips ```json fences and normalizes the schema', () => {
  const out = parseExtractionResponse('```json\n{"form_type":"admission","student_name":"Riya Rao","student_id":"12","date":"2026-08-01","fields":{"class":"9A"},"confidence":0.91,"needs_human_review":false}\n```');
  assert.equal(out.form_type, 'admission');
  assert.equal(out.student_name, 'Riya Rao');
  assert.equal(out.confidence, 0.91);
  assert.equal(out.needs_human_review, false);
  assert.deepEqual(out.fields, { class: '9A' });
});

test('parseExtractionResponse clamps confidence and forces review below 0.6', () => {
  const out = parseExtractionResponse('{"form_type":"medical","confidence":0.34,"needs_human_review":false}');
  assert.equal(out.needs_human_review, true, 'low confidence must force human review');
  const clamped = parseExtractionResponse('{"form_type":"other","confidence":4.5}');
  assert.equal(clamped.confidence, 1);
});

test('parseExtractionResponse maps unknown form types and null fields safely', () => {
  const out = parseExtractionResponse('{"form_type":"wizard","confidence":0.5,"fields":"nope"}');
  assert.equal(out.form_type, 'other');
  assert.deepEqual(out.fields, {});
  assert.equal(out.student_name, null);
});

test('parseExtractionResponse throws on malformed JSON (caller falls back)', () => {
  assert.throws(() => parseExtractionResponse('{"form_type": '));
  assert.throws(() => parseExtractionResponse(''));
});

test('extractDocument returns structured data when the model replies valid JSON', async () => {
  const file = tmpFile(Buffer.from('fake jpeg bytes'));
  try {
    const result = await extractDocument(file, {
      apiKey: 'test-key',
      client: mockClient('{"form_type":"fee_receipt","student_name":"Aarav Sharma","confidence":0.88,"fields":{"amount":"42500"},"needs_human_review":false}'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.form_type, 'fee_receipt');
    assert.equal(result.data.confidence, 0.88);
  } finally {
    fs.unlinkSync(file);
  }
});

test('extractDocument falls back gracefully on malformed model JSON', async () => {
  const file = tmpFile('garbage');
  try {
    const result = await extractDocument(file, { apiKey: 'test-key', client: mockClient('this is not json') });
    assert.equal(result.ok, false);
    assert.ok(result.error, 'an error message is provided');
  } finally {
    fs.unlinkSync(file);
  }
});

test('extractDocument reports a missing file without throwing', async () => {
  const result = await extractDocument(path.join(os.tmpdir(), 'does-not-exist-xyz.jpg'), {
    apiKey: 'test-key',
    client: mockClient('{}'),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /could not read uploaded file/);
});

test('extractDocument refuses without an API key (never calls the model)', async () => {
  let called = false;
  const file = tmpFile('x');
  try {
    const result = await extractDocument(file, {
      client: async () => { called = true; return '{}'; },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /GEMINI_API_KEY/);
    assert.equal(called, false, 'model client must not be invoked without a key');
  } finally {
    fs.unlinkSync(file);
  }
});

test('geminiClient posts inline_data and parses candidates[].content.parts[].text', async () => {
  let captured;
  const { server, base } = await stubGeminiServer((req, res, body) => {
    captured = { url: req.url, method: req.method, body: JSON.parse(body) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"form_type":"admission","student_name":"Riya Rao","confidence":0.9,"fields":{},"needs_human_review":false}' }] } }],
    }));
  });
  try {
    const text = await geminiClient({
      apiKey: 'AIza-test', model: 'gemini-3.6-flash', mediaType: 'image/jpeg',
      base64: 'ZmFrZQ==', prompt: 'p', timeoutMs: 5000, apiUrl: base,
    });
    assert.equal(captured.method, 'POST');
    assert.match(captured.url, /^\/models\/gemini-3\.6-flash:generateContent\?key=AIza-test$/);
    const part = captured.body.contents[0].parts[0];
    assert.equal(part.inline_data.mime_type, 'image/jpeg', 'Gemini uses inline_data/mime_type snake_case');
    assert.equal(part.inline_data.data, 'ZmFrZQ==');
    assert.equal(captured.body.contents[0].parts[1].text, 'p');
    assert.equal(captured.body.generationConfig.responseMimeType, 'application/json');
    assert.match(text, /"student_name":"Riya Rao"/, 'text is joined from candidates[].content.parts[].text');
  } finally {
    server.close();
  }
});

test('geminiClient surfaces the API error message (e.g. 429 rate limit)', async () => {
  const { server, base } = await stubGeminiServer((req, res) => {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 429, message: 'RESOURCE_EXHAUSTED: rate limit exceeded' } }));
  });
  try {
    await assert.rejects(
      geminiClient({ apiKey: 'k', model: 'gemini-3.6-flash', mediaType: 'image/jpeg', base64: 'x', prompt: 'p', timeoutMs: 5000, apiUrl: base }),
      /rate limit exceeded/,
      'the API message (not just a status code) is propagated'
    );
  } finally {
    server.close();
  }
});

test('extractDocument runs the real geminiClient end-to-end via apiUrl (default model)', async () => {
  // Pins the full path: extractDocument -> geminiClient (stub server) -> parsed
  // schema, AND that the default GEMINI_MODEL (no model passed) is used.
  let capturedUrl;
  const { server, base } = await stubGeminiServer((req, res) => {
    capturedUrl = req.url;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"form_type":"fee_receipt","student_name":"Rohan Verma","confidence":0.93,"fields":{"amount":"42500"},"needs_human_review":false}' }] } }],
    }));
  });
  const file = tmpFile(Buffer.from('fake jpeg bytes'));
  try {
    const result = await extractDocument(file, { apiKey: 'AIza-test', apiUrl: base, timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.data.form_type, 'fee_receipt');
    assert.equal(result.data.student_name, 'Rohan Verma');
    assert.equal(result.data.confidence, 0.93);
    assert.match(capturedUrl, /gemini-3\.6-flash:generateContent/, 'default model is gemini-3.6-flash');
  } finally {
    server.close();
    fs.unlinkSync(file);
  }
});

test('geminiClient throws when the response has no text parts', async () => {
  const { server, base } = await stubGeminiServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'x' } }] } }] }));
  });
  try {
    await assert.rejects(
      geminiClient({ apiKey: 'k', model: 'gemini-3.6-flash', mediaType: 'image/jpeg', base64: 'x', prompt: 'p', timeoutMs: 5000, apiUrl: base }),
      /no text content/
    );
  } finally {
    server.close();
  }
});

test('extractDocument converts a client/network failure into a fallback result', async () => {
  const file = tmpFile('x');
  try {
    const result = await extractDocument(file, {
      apiKey: 'test-key',
      client: async () => { throw new Error('boom: rate limited'); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /rate limited/);
  } finally {
    fs.unlinkSync(file);
  }
});
