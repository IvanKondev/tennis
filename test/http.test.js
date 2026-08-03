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

// --------------------------------------------------------------------------
// Group format + archive.
//
// These run last: they replace the whole tournament state via PUT /api/data,
// which is exactly the Import path. Everything above operates on the flat
// A/B/C roster seeded at the top of this file.
// --------------------------------------------------------------------------
async function adminToken() {
  const auth = await request('POST', '/api/auth', { body: { password: 'integration-pass' } });
  return auth.json.token;
}

const GROUPED_STATE = {
  players: ['Сашо', 'Белев', 'Иво', 'Никата', 'Нако', 'Гого'],
  tournament: {
    name: 'Турнир лято 2026',
    groups: [
      { name: 'Група 1', players: ['Сашо', 'Белев', 'Иво'] },
      { name: 'Група 2', players: ['Никата', 'Нако', 'Гого'] }
    ],
    extraPairs: []
  },
  results: {},
  schedule: {},
  live: {},
  resultsRecordedAt: {},
  archive: [{
    id: 'spring-2026',
    name: 'Турнир пролет 2026',
    endedAt: '2026-07-31',
    // Own roster, own canonical order — "Иво|Сашо" is correct here even though
    // the active roster above would canonicalize it as "Сашо|Иво".
    players: ['Иво', 'Сашо'],
    results: { 'Иво|Сашо': [0, 2] },
    resultsRecordedAt: { 'Иво|Сашо': '2026-06-28T08:28:04.215Z' },
    groups: null
  }]
};

test('PUT /api/data installs a grouped tournament + archive', async () => {
  const token = await adminToken();
  const r = await request('PUT', '/api/data', {
    headers: { 'X-Admin-Token': token },
    body: GROUPED_STATE
  });
  assert.equal(r.status, 200);

  const got = await request('GET', '/api/data');
  assert.equal(got.json.players.length, 6);
  assert.equal(got.json.tournament.name, 'Турнир лято 2026');
  assert.equal(got.json.tournament.groups.length, 2);
  assert.equal(got.json.archive.length, 1);
  assert.equal(got.json.archive[0].name, 'Турнир пролет 2026');
});

test('POST result for a WITHIN-group pair → 200', async () => {
  const token = await adminToken();
  const r = await request('POST', '/api/match/' + encodeURIComponent('Сашо|Белев') + '/result', {
    headers: { 'X-Admin-Token': token },
    body: { s1: 2, s2: 0 }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.result, [2, 0]);
});

test('POST result for a CROSS-group pair → 404 (not a fixture)', async () => {
  const token = await adminToken();
  const r = await request('POST', '/api/match/' + encodeURIComponent('Сашо|Никата') + '/result', {
    headers: { 'X-Admin-Token': token },
    body: { s1: 2, s2: 0 }
  });
  assert.equal(r.status, 404);
});

test('POST /api/players requires a group when the tournament is split', async () => {
  const token = await adminToken();
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name: 'Безгрупов' }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /group required/);
});

test('POST /api/players with an unknown group → 400', async () => {
  const token = await adminToken();
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name: 'Нов', group: 'Група 9' }
  });
  assert.equal(r.status, 400);
});

test('POST /api/players joins the named group', async () => {
  const token = await adminToken();
  const name = 'Нов-' + Date.now();
  const r = await request('POST', '/api/players', {
    headers: { 'X-Admin-Token': token },
    body: { name, group: 'Група 2' }
  });
  assert.equal(r.status, 200);
  assert.ok(r.json.players.includes(name));
  const g2 = r.json.tournament.groups.find(g => g.name === 'Група 2');
  assert.ok(g2.players.includes(name));
  // Now a fixture against a Група 2 member exists...
  const ok = await request('POST', '/api/match/' + encodeURIComponent('Никата|' + name) + '/result', {
    headers: { 'X-Admin-Token': token },
    body: { s1: 2, s2: 0 }
  });
  assert.equal(ok.status, 200);
});

test('PUT /api/data without archive/tournament keeps them (normal score write)', async () => {
  const token = await adminToken();
  const before = await request('GET', '/api/data');
  const r = await request('PUT', '/api/data', {
    headers: { 'X-Admin-Token': token },
    body: {
      results: before.json.results,
      schedule: {},
      live: {},
      resultsRecordedAt: before.json.resultsRecordedAt
    }
  });
  assert.equal(r.status, 200);
  const after = await request('GET', '/api/data');
  assert.equal(after.json.archive.length, 1);
  assert.equal(after.json.tournament.name, 'Турнир лято 2026');
  assert.deepEqual(after.json.players, before.json.players);
});

test('PUT /api/data rejects a cross-group result key', async () => {
  const token = await adminToken();
  const r = await request('PUT', '/api/data', {
    headers: { 'X-Admin-Token': token },
    body: {
      results: { 'Сашо|Никата': [2, 0] },
      schedule: {}, live: {}, resultsRecordedAt: {}
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /invalid result key/);
});

test('PUT /api/data rejects a group player who is not on the roster', async () => {
  const token = await adminToken();
  const r = await request('PUT', '/api/data', {
    headers: { 'X-Admin-Token': token },
    body: {
      ...GROUPED_STATE,
      tournament: {
        name: 'Bad',
        groups: [{ name: 'G1', players: ['Сашо', 'Непознат'] }],
        extraPairs: []
      }
    }
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /not on roster/);
});

test('extraPairs enable the winners final without a code change', async () => {
  const token = await adminToken();
  const install = await request('PUT', '/api/data', {
    headers: { 'X-Admin-Token': token },
    body: {
      ...GROUPED_STATE,
      tournament: { ...GROUPED_STATE.tournament, extraPairs: ['Сашо|Никата'] }
    }
  });
  assert.equal(install.status, 200);
  const r = await request('POST', '/api/match/' + encodeURIComponent('Сашо|Никата') + '/result', {
    headers: { 'X-Admin-Token': token },
    body: { s1: 2, s2: 1 }
  });
  assert.equal(r.status, 200);
});
