'use strict';

// Integration smoke tests — boot the actual HTTP server (on a random port)
// and exercise the public endpoints. Catches handler-wiring bugs that pure
// unit tests can't see (e.g. wrong status code, missing Allow header,
// admin-auth header check).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-int-'));
process.env.DATA_DIR = TMP_ROOT;
process.env.ADMIN_PASSWORD = 'test-pass';

const { server } = require('../server.js');

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

async function req(method, pathname, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  let body = null;
  try { body = await r.json(); } catch (e) {}
  return { status: r.status, body, headers: r.headers };
}

const ADMIN = { 'X-Admin-Password': 'test-pass' };

// --------------------------------------------------------------------------
// /api/health
// --------------------------------------------------------------------------
test('GET /api/health returns ok + hasAdmin flag', async () => {
  const r = await req('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.hasAdmin, true);
});

// --------------------------------------------------------------------------
// /api/data
// --------------------------------------------------------------------------
test('GET /api/data returns initial state with seeded players', async () => {
  const r = await req('GET', '/api/data');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.players));
  assert.ok(r.body.players.length >= 2);
});

test('PUT /api/data without admin password → 401', async () => {
  const r = await req('PUT', '/api/data', { body: { results: {}, schedule: {} } });
  assert.equal(r.status, 401);
});

test('PUT /api/data with admin → 200', async () => {
  const r = await req('PUT', '/api/data', {
    headers: ADMIN,
    body: { results: {}, schedule: {}, live: {}, resultsRecordedAt: {} }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('PUT /api/data rejects invalid result key', async () => {
  const r = await req('PUT', '/api/data', {
    headers: ADMIN,
    body: { results: { 'NoSuchPlayer|Other': [2, 0] }, schedule: {} }
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /invalid result key/);
});

test('PUT /api/data rejects invalid result value', async () => {
  // First seed a real key by reading current players
  const cur = await req('GET', '/api/data');
  const [p1, p2] = cur.body.players;
  const r = await req('PUT', '/api/data', {
    headers: ADMIN,
    body: { results: { [p1 + '|' + p2]: [3, 0] }, schedule: {} }  // 3 is out of range
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /invalid result value/);
});

test('DELETE /api/data → 405 with Allow header', async () => {
  const r = await req('DELETE', '/api/data');
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('allow'), 'GET, PUT');
});

// --------------------------------------------------------------------------
// /api/players
// --------------------------------------------------------------------------
test('POST /api/players without admin → 401', async () => {
  const r = await req('POST', '/api/players', { body: { name: 'Newbie' } });
  assert.equal(r.status, 401);
});

test('POST /api/players adds a player and returns updated list', async () => {
  const r = await req('POST', '/api/players', {
    headers: ADMIN,
    body: { name: 'TestNewbie' }
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.players.includes('TestNewbie'));
});

test('POST /api/players rejects duplicate', async () => {
  const r = await req('POST', '/api/players', {
    headers: ADMIN,
    body: { name: 'TestNewbie' }
  });
  assert.equal(r.status, 409);
});

test('POST /api/players rejects empty name', async () => {
  const r = await req('POST', '/api/players', {
    headers: ADMIN,
    body: { name: '   ' }
  });
  assert.equal(r.status, 400);
});

test('POST /api/players rejects name with "|"', async () => {
  const r = await req('POST', '/api/players', {
    headers: ADMIN,
    body: { name: 'Bad|Name' }
  });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// /api/players/<name> rename
// --------------------------------------------------------------------------
test('PATCH /api/players/<name> renames + remaps keys', async () => {
  // Seed: add two players, record a result between them, then rename one.
  await req('POST', '/api/players', { headers: ADMIN, body: { name: 'Alpha' } });
  await req('POST', '/api/players', { headers: ADMIN, body: { name: 'Beta' } });

  // Record a result so we can verify the migration carried it over.
  const cur = await req('GET', '/api/data');
  // Canonical order: Alpha was added before Beta.
  const key = 'Alpha|Beta';
  await req('PUT', '/api/data', {
    headers: ADMIN,
    body: {
      results: { [key]: [2, 0], ...cur.body.results },
      schedule: cur.body.schedule || {},
      live: cur.body.live || {},
      resultsRecordedAt: { [key]: new Date().toISOString(), ...cur.body.resultsRecordedAt }
    }
  });

  const r = await req('PATCH', '/api/players/Alpha', {
    headers: ADMIN,
    body: { name: 'AlphaRenamed' }
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.players.includes('AlphaRenamed'));
  assert.ok(!r.body.players.includes('Alpha'));

  const after = await req('GET', '/api/data');
  assert.deepEqual(after.body.results['AlphaRenamed|Beta'], [2, 0]);
  assert.equal(after.body.results['Alpha|Beta'], undefined);
});

test('PATCH unknown player → 404', async () => {
  const r = await req('PATCH', '/api/players/NoSuchPlayer', {
    headers: ADMIN,
    body: { name: 'Whatever' }
  });
  assert.equal(r.status, 404);
});

test('PATCH to existing name → 409', async () => {
  const r = await req('PATCH', '/api/players/Beta', {
    headers: ADMIN,
    body: { name: 'AlphaRenamed' }  // already exists from earlier test
  });
  assert.equal(r.status, 409);
});

// --------------------------------------------------------------------------
// /api/players/<name> delete
// --------------------------------------------------------------------------
test('DELETE /api/players/<name> removes player + cascades matches', async () => {
  const r = await req('DELETE', '/api/players/AlphaRenamed', { headers: ADMIN });
  assert.equal(r.status, 200);
  assert.ok(!r.body.players.includes('AlphaRenamed'));

  const after = await req('GET', '/api/data');
  // The Alpha|Beta match (renamed to AlphaRenamed|Beta) should be gone.
  for (const k in after.body.results) {
    assert.ok(!k.includes('AlphaRenamed'), 'orphan result key: ' + k);
  }
});

test('DELETE refuses if it would leave fewer than 2 players', async () => {
  // Build a fresh state with only 2 players so deletion would breach the floor.
  await req('PUT', '/api/data', {
    headers: ADMIN,
    body: { results: {}, schedule: {}, live: {}, resultsRecordedAt: {} }
  });
  // Read current players, delete down to 2.
  let cur = (await req('GET', '/api/data')).body;
  while (cur.players.length > 2) {
    const last = cur.players[cur.players.length - 1];
    await req('DELETE', '/api/players/' + encodeURIComponent(last), { headers: ADMIN });
    cur = (await req('GET', '/api/data')).body;
  }
  assert.equal(cur.players.length, 2);
  const r = await req('DELETE', '/api/players/' + encodeURIComponent(cur.players[0]), { headers: ADMIN });
  assert.equal(r.status, 400);
});

// --------------------------------------------------------------------------
// Match-scoped endpoints (live / result)
// --------------------------------------------------------------------------
test('POST /api/match/<unknown>/live → 404', async () => {
  const r = await req('POST', '/api/match/' + encodeURIComponent('Nobody|Else') + '/live', {
    headers: ADMIN,
    body: { sets: [], cur: [0, 0], tb: null }
  });
  assert.equal(r.status, 404);
});

test('POST /api/match/<key>/result records final score (admin)', async () => {
  // Seed two fresh known players so we have a deterministic key.
  await req('POST', '/api/players', { headers: ADMIN, body: { name: 'Pa' } });
  await req('POST', '/api/players', { headers: ADMIN, body: { name: 'Pb' } });
  const r = await req('POST', '/api/match/' + encodeURIComponent('Pa|Pb') + '/result', {
    headers: ADMIN,
    body: { s1: 2, s2: 1 }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result, [2, 1]);

  const after = await req('GET', '/api/data');
  assert.deepEqual(after.body.results['Pa|Pb'], [2, 1]);
  assert.ok(after.body.resultsRecordedAt['Pa|Pb']);
});

test('POST /api/match/<key>/result rejects invalid score', async () => {
  const r = await req('POST', '/api/match/' + encodeURIComponent('Pa|Pb') + '/result', {
    headers: ADMIN,
    body: { s1: 3, s2: 0 }  // 3 is out of range
  });
  assert.equal(r.status, 400);
});
