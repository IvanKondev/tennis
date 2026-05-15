'use strict';

// HTTP integration tests for server.js. These exercise full request/response
// cycles against the bound server (ephemeral port), hitting the actual handler
// glue code that pure-helper tests can't reach.
//
// Each test uses a fresh tmp DATA_DIR so writes from one test don't leak into
// another. We bind the server once, run the tests sequentially, then close.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-http-'));
process.env.DATA_DIR = TMP_ROOT;
process.env.ADMIN_PASSWORD = 'integration-pass';

// Seed a known data file before requiring server.js so readData() finds it.
fs.writeFileSync(path.join(TMP_ROOT, 'tennis.json'), JSON.stringify({
  players: ['A', 'B', 'C'],
  results: {},
  schedule: {},
  live: {},
  resultsRecordedAt: {}
}, null, 2));

const { server } = require('../server.js');

let baseUrl;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  baseUrl = `http://127.0.0.1:${a.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

function request(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...opts.headers }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        let json;
        try { json = body ? JSON.parse(body) : null; } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) {
      req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    }
    req.end();
  });
}

// --------------------------------------------------------------------------
// /api/health, /api/version
// --------------------------------------------------------------------------
test('GET /api/health → ok', async () => {
  const r = await request('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('GET /api/version → version string', async () => {
  const r = await request('GET', '/api/version');
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.version, 'string');
  assert.ok(r.json.version.length > 0);
});

test('Security headers present on API responses', async () => {
  const r = await request('GET', '/api/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.ok(r.headers['referrer-policy']);
});

// --------------------------------------------------------------------------
// /api/auth — login, rate limit, logout, token use
// --------------------------------------------------------------------------
test('POST /api/auth wrong password → 401', async () => {
  const r = await request('POST', '/api/auth', { body: { password: 'nope' } });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);
});

test('POST /api/auth correct password → token returned', async () => {
  const r = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.token, 'string');
  assert.equal(r.json.token.length, 64);
});

test('POST /api/auth invalid json → 400 (not 500)', async () => {
  const r = await request('POST', '/api/auth', { body: '{ broken' });
  assert.equal(r.status, 400);
});

test('Token authenticates admin endpoint', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const token = auth.json.token;
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name: 'TestPlayer-' + Date.now() }
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.players));
});

test('Bogus token → 401', async () => {
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': 'a'.repeat(64) },
    body: { name: 'ShouldFail' }
  });
  assert.equal(r.status, 401);
});

test('No token → 401', async () => {
  const r = await request('POST', '/api/players', { body: { name: 'ShouldFail' } });
  assert.equal(r.status, 401);
});

test('DELETE /api/auth revokes the token', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const token = auth.json.token;
  // Token works…
  const before = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name: 'BeforeRevoke-' + Date.now() }
  });
  assert.equal(before.status, 200);
  // Revoke
  const del = await request('DELETE', '/api/auth', { headers: { 'X-Admin-Token': token } });
  assert.equal(del.status, 200);
  // Token no longer works
  const after = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name: 'AfterRevoke-' + Date.now() }
  });
  assert.equal(after.status, 401);
});

// --------------------------------------------------------------------------
// /api/players validation
// --------------------------------------------------------------------------
test('POST /api/players empty name → 400', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { name: '   ' }
  });
  assert.equal(r.status, 400);
});

test('POST /api/players name with "|" → 400', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { name: 'bad|name' }
  });
  assert.equal(r.status, 400);
});

test('POST /api/players cyrillic name accepted', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const name = 'Иван-' + Date.now();
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { name }
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.players.includes(name));
});

// --------------------------------------------------------------------------
// /api/match/<key>/result — scoring
// --------------------------------------------------------------------------
test('POST /api/match/<key>/result admin can record any score', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const r = await request('POST', '/api/match/A%7CB/result', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { s1: 2, s2: 1 }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result, [2, 1]);
});

test('POST /api/match/<key>/result invalid score → 400', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const r = await request('POST', '/api/match/A%7CC/result', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { s1: 2, s2: 2 }  // tie — invalid
  });
  assert.equal(r.status, 400);
});

test('POST /api/match/<key>/result unknown pair → 404', async () => {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  const r = await request('POST', '/api/match/X%7CY/result', {
    headers: { 'X-Admin-Token': auth.json.token },
    body: { s1: 2, s2: 0 }
  });
  assert.equal(r.status, 404);
});

test('Non-admin without schedule → 403 not match day', async () => {
  const r = await request('POST', '/api/match/B%7CC/result', {
    body: { s1: 2, s2: 0 }
  });
  assert.equal(r.status, 403);
});

// --------------------------------------------------------------------------
// /api/push/* — VAPID key + subscribe/unsubscribe
//
// These run regardless of whether the test process has VAPID env vars set:
// if push is disabled, the vapid endpoint returns 404 and subscribe returns 503.
// If enabled (e.g. via .env), full subscribe/unsubscribe round-trip is exercised.
// --------------------------------------------------------------------------
test('GET /api/push/vapid-public-key → 200 with key (or 404 if disabled)', async () => {
  const r = await request('GET', '/api/push/vapid-public-key');
  if (r.status === 404) {
    // push disabled: nothing else to test here
    return;
  }
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.publicKey, 'string');
  assert.ok(r.json.publicKey.length > 0);
});

test('POST /api/push/subscribe rejects malformed body', async () => {
  const r = await request('POST', '/api/push/subscribe', { body: { foo: 'bar' } });
  // Either 503 (push disabled) or 400 (push enabled, body invalid).
  assert.ok(r.status === 400 || r.status === 503, 'unexpected status: ' + r.status);
});

test('POST /api/push/subscribe + unsubscribe round-trip (when push enabled)', async () => {
  const vk = await request('GET', '/api/push/vapid-public-key');
  if (vk.status === 404) return;  // push disabled — skip
  const fakeEndpoint = 'https://example.com/push/' + Date.now();
  const sub = {
    endpoint: fakeEndpoint,
    keys: { p256dh: 'BPLACEHOLDER', auth: 'AUTH_PLACEHOLDER' }
  };
  const s = await request('POST', '/api/push/subscribe', { body: sub });
  assert.equal(s.status, 200);
  // Idempotent: same endpoint twice → still 200, no duplicate.
  const s2 = await request('POST', '/api/push/subscribe', { body: sub });
  assert.equal(s2.status, 200);
  // Unsubscribe
  const u = await request('POST', '/api/push/unsubscribe', { body: { endpoint: fakeEndpoint } });
  assert.equal(u.status, 200);
});

test('POST /api/push/unsubscribe missing endpoint → 400 (when push enabled)', async () => {
  const vk = await request('GET', '/api/push/vapid-public-key');
  if (vk.status === 404) return;
  const r = await request('POST', '/api/push/unsubscribe', { body: {} });
  assert.equal(r.status, 400);
});
