'use strict';

// Unit tests for server.js using Node's built-in test runner (node:test).
// No external dependencies — runs with: `node --test test/`
// or `npm test` if package.json is present.
//
// We override DATA_DIR to a temporary path BEFORE requiring server.js so the
// module loads against an isolated data file. The exported helpers are then
// tested directly without needing to bind a real HTTP port.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tennis-test-'));
process.env.DATA_DIR = TMP_ROOT;
process.env.ADMIN_PASSWORD = 'test-pass';

const {
  buildValidKeys,
  clampInt,
  validateLiveBody,
  migratePlayerRename,
  migratePlayerDelete,
  safeStringEqual,
  todayLocalISO,
  authRateCheck,
  authRateRecord,
  readData,
  writeData
} = require('../server.js');

// --------------------------------------------------------------------------
// buildValidKeys: round-robin pair set from a player list.
// --------------------------------------------------------------------------
test('buildValidKeys: empty list returns empty set', () => {
  assert.equal(buildValidKeys([]).size, 0);
});

test('buildValidKeys: single player returns empty set (no pairs)', () => {
  assert.equal(buildValidKeys(['Иво']).size, 0);
});

test('buildValidKeys: 3 players returns 3 pairs in canonical order', () => {
  const set = buildValidKeys(['A', 'B', 'C']);
  assert.equal(set.size, 3);
  assert.ok(set.has('A|B'));
  assert.ok(set.has('A|C'));
  assert.ok(set.has('B|C'));
  // Non-canonical order is rejected — keys are first|second by list index.
  assert.ok(!set.has('B|A'));
});

test('buildValidKeys: n players → C(n,2) pairs', () => {
  const players = Array.from({ length: 20 }, (_, i) => 'p' + i);
  // C(20,2) = 190 — same as MATCHES_SEED size.
  assert.equal(buildValidKeys(players).size, 190);
});

test('buildValidKeys: cyrillic names work', () => {
  const set = buildValidKeys(['Вики', 'Иво', 'Жоро Б']);
  assert.ok(set.has('Вики|Иво'));
  assert.ok(set.has('Вики|Жоро Б'));
  assert.ok(set.has('Иво|Жоро Б'));
});

// --------------------------------------------------------------------------
// clampInt
// --------------------------------------------------------------------------
test('clampInt: valid integer in range', () => {
  assert.equal(clampInt(5, 0, 10), 5);
});

test('clampInt: integer at boundary inclusive', () => {
  assert.equal(clampInt(0, 0, 10), 0);
  assert.equal(clampInt(10, 0, 10), 10);
});

test('clampInt: out of range returns null', () => {
  assert.equal(clampInt(-1, 0, 10), null);
  assert.equal(clampInt(11, 0, 10), null);
});

test('clampInt: non-number returns null', () => {
  assert.equal(clampInt('5', 0, 10), null);
  assert.equal(clampInt(null, 0, 10), null);
  assert.equal(clampInt(undefined, 0, 10), null);
  assert.equal(clampInt(NaN, 0, 10), null);
  assert.equal(clampInt(Infinity, 0, 10), null);
});

test('clampInt: floors decimals', () => {
  assert.equal(clampInt(5.7, 0, 10), 5);
});

// --------------------------------------------------------------------------
// validateLiveBody
// --------------------------------------------------------------------------
test('validateLiveBody: valid empty start state', () => {
  const v = validateLiveBody({ sets: [], cur: [0, 0], tb: null });
  assert.deepEqual(v.sets, []);
  assert.deepEqual(v.cur, [0, 0]);
  assert.equal(v.tb, null);
});

test('validateLiveBody: valid mid-game with one completed set', () => {
  const v = validateLiveBody({ sets: [[6, 4]], cur: [3, 2], tb: null });
  assert.deepEqual(v.sets, [[6, 4]]);
  assert.deepEqual(v.cur, [3, 2]);
});

test('validateLiveBody: valid tiebreak in progress', () => {
  const v = validateLiveBody({ sets: [], cur: [6, 6], tb: [5, 4] });
  assert.deepEqual(v.tb, [5, 4]);
});

test('validateLiveBody: rejects missing cur', () => {
  assert.equal(validateLiveBody({ sets: [], tb: null }), null);
});

test('validateLiveBody: rejects malformed set', () => {
  assert.equal(validateLiveBody({ sets: [['x', 0]], cur: [0, 0], tb: null }), null);
  assert.equal(validateLiveBody({ sets: [[1]], cur: [0, 0], tb: null }), null);
});

test('validateLiveBody: rejects out-of-range games', () => {
  assert.equal(validateLiveBody({ sets: [[31, 0]], cur: [0, 0], tb: null }), null);
});

test('validateLiveBody: rejects out-of-range cur', () => {
  assert.equal(validateLiveBody({ sets: [], cur: [31, 0], tb: null }), null);
});

test('validateLiveBody: rejects too many sets', () => {
  const sets = Array.from({ length: 6 }, () => [6, 0]);
  assert.equal(validateLiveBody({ sets, cur: [0, 0], tb: null }), null);
});

test('validateLiveBody: rejects null/non-object', () => {
  assert.equal(validateLiveBody(null), null);
  assert.equal(validateLiveBody('string'), null);
  assert.equal(validateLiveBody(42), null);
});

// --------------------------------------------------------------------------
// migratePlayerRename: pure transform
// --------------------------------------------------------------------------
function fixture() {
  return {
    players: ['A', 'B', 'C'],
    results: { 'A|B': [2, 0], 'A|C': [2, 1], 'B|C': [0, 2] },
    schedule: { 'A|C': '2026-05-09T15:00' },
    live: { 'B|C': { sets: [], cur: [3, 2], tb: null, updatedAt: 'x' } },
    resultsRecordedAt: { 'A|B': 't1', 'A|C': 't2', 'B|C': 't3' }
  };
}

test('migratePlayerRename: substitutes name in player list', () => {
  const out = migratePlayerRename(fixture(), 'A', 'Z');
  assert.deepEqual(out.players, ['Z', 'B', 'C']);
});

test('migratePlayerRename: substitutes name in match keys preserving canonical order', () => {
  const out = migratePlayerRename(fixture(), 'A', 'Z');
  // 'A|B' → 'Z|B' (A was first; Z substitutes in same slot)
  assert.deepEqual(Object.keys(out.results).sort(), ['B|C', 'Z|B', 'Z|C']);
  assert.deepEqual(out.results['Z|B'], [2, 0]);
  assert.deepEqual(out.results['Z|C'], [2, 1]);
});

test('migratePlayerRename: migrates schedule + live + recordedAt together', () => {
  const out = migratePlayerRename(fixture(), 'C', 'Y');
  assert.equal(out.schedule['A|Y'], '2026-05-09T15:00');
  assert.ok(out.live['B|Y']);
  assert.equal(out.resultsRecordedAt['A|Y'], 't2');
  assert.equal(out.resultsRecordedAt['B|Y'], 't3');
});

test('migratePlayerRename: untouched keys stay unchanged', () => {
  const before = fixture();
  const out = migratePlayerRename(before, 'A', 'Z');
  // 'B|C' did not involve A — must remain identical and reference-equal value.
  assert.deepEqual(out.results['B|C'], [0, 2]);
});

test('migratePlayerRename: total key count preserved', () => {
  const before = fixture();
  const out = migratePlayerRename(before, 'B', 'Q');
  assert.equal(Object.keys(out.results).length, Object.keys(before.results).length);
});

test('migratePlayerRename: input is not mutated', () => {
  const before = fixture();
  const snapshot = JSON.stringify(before);
  migratePlayerRename(before, 'A', 'Z');
  assert.equal(JSON.stringify(before), snapshot);
});

// --------------------------------------------------------------------------
// migratePlayerDelete: pure transform
// --------------------------------------------------------------------------
test('migratePlayerDelete: removes player from list', () => {
  const out = migratePlayerDelete(fixture(), 'A');
  assert.deepEqual(out.players, ['B', 'C']);
});

test('migratePlayerDelete: drops every key involving the player', () => {
  const out = migratePlayerDelete(fixture(), 'A');
  assert.equal(out.results['A|B'], undefined);
  assert.equal(out.results['A|C'], undefined);
  assert.deepEqual(out.results['B|C'], [0, 2]);  // unrelated stays
});

test('migratePlayerDelete: cascades through schedule, live, recordedAt', () => {
  const out = migratePlayerDelete(fixture(), 'C');
  assert.equal(out.schedule['A|C'], undefined);
  assert.equal(out.live['B|C'], undefined);
  assert.equal(out.resultsRecordedAt['A|C'], undefined);
  assert.equal(out.resultsRecordedAt['B|C'], undefined);
  // A|B did not involve C — survives.
  assert.deepEqual(out.results['A|B'], [2, 0]);
  assert.equal(out.resultsRecordedAt['A|B'], 't1');
});

test('migratePlayerDelete: input is not mutated', () => {
  const before = fixture();
  const snapshot = JSON.stringify(before);
  migratePlayerDelete(before, 'A');
  assert.equal(JSON.stringify(before), snapshot);
});

// --------------------------------------------------------------------------
// readData / writeData: durability + backup rotation
// --------------------------------------------------------------------------
test('writeData: persists JSON readable by readData', () => {
  const data = {
    players: ['X', 'Y'],
    results: { 'X|Y': [2, 0] },
    schedule: {},
    live: {},
    resultsRecordedAt: { 'X|Y': '2026-05-09T10:00:00Z' }
  };
  writeData(data);
  const back = readData();
  assert.deepEqual(back.players, ['X', 'Y']);
  assert.deepEqual(back.results, { 'X|Y': [2, 0] });
  assert.deepEqual(back.resultsRecordedAt, { 'X|Y': '2026-05-09T10:00:00Z' });
});

test('writeData: rotates backups bak.1 → bak.2 → bak.3', () => {
  const dataFile = path.join(TMP_ROOT, 'tennis.json');
  // Three writes with distinct contents → bak.1/.bak.2/.bak.3 should hold
  // the previous three states in reverse chronological order.
  writeData({ players: ['gen0'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });
  writeData({ players: ['gen1'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });
  writeData({ players: ['gen2'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });
  writeData({ players: ['gen3'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });

  const cur = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  const bak1 = JSON.parse(fs.readFileSync(dataFile + '.bak.1', 'utf-8'));
  const bak2 = JSON.parse(fs.readFileSync(dataFile + '.bak.2', 'utf-8'));
  const bak3 = JSON.parse(fs.readFileSync(dataFile + '.bak.3', 'utf-8'));

  assert.deepEqual(cur.players, ['gen3']);
  assert.deepEqual(bak1.players, ['gen2']);
  assert.deepEqual(bak2.players, ['gen1']);
  assert.deepEqual(bak3.players, ['gen0']);
});

test('readData: throws EBADJSON on corrupt file (not silent default)', () => {
  const dataFile = path.join(TMP_ROOT, 'tennis.json');
  fs.writeFileSync(dataFile, '{ this is : not json');
  assert.throws(() => readData(), (err) => err.code === 'EBADJSON');
});

test('readData: bootstraps players from PLAYERS when missing', () => {
  const dataFile = path.join(TMP_ROOT, 'tennis.json');
  fs.writeFileSync(dataFile, JSON.stringify({ results: {} }));
  const d = readData();
  assert.ok(Array.isArray(d.players));
  assert.ok(d.players.length >= 2);
});

test('readData: empty arrays/objects are filled with defaults', () => {
  const dataFile = path.join(TMP_ROOT, 'tennis.json');
  fs.writeFileSync(dataFile, JSON.stringify({ players: ['A', 'B'] }));
  const d = readData();
  assert.deepEqual(d.results, {});
  assert.deepEqual(d.schedule, {});
  assert.deepEqual(d.live, {});
  assert.deepEqual(d.resultsRecordedAt, {});
});

// --------------------------------------------------------------------------
// Round-trip: rename via migrate + persist
// --------------------------------------------------------------------------
test('round-trip: migrate rename then writeData/readData preserves shape', () => {
  const start = {
    players: ['Иво', 'Митко', 'Жоро Б'],
    results: { 'Иво|Митко': [2, 1], 'Митко|Жоро Б': [0, 2] },
    schedule: {},
    live: {},
    resultsRecordedAt: { 'Иво|Митко': '2026-05-09T10:00:00Z' }
  };
  writeData(start);
  const data = readData();
  const renamed = migratePlayerRename(data, 'Митко', 'Митёе');
  writeData(renamed);
  const back = readData();
  assert.deepEqual(back.players, ['Иво', 'Митёе', 'Жоро Б']);
  assert.deepEqual(back.results['Иво|Митёе'], [2, 1]);
  assert.deepEqual(back.results['Митёе|Жоро Б'], [0, 2]);
  assert.equal(back.results['Иво|Митко'], undefined);
});

// --------------------------------------------------------------------------
// safeStringEqual: constant-time compare
// --------------------------------------------------------------------------
test('safeStringEqual: equal strings → true', () => {
  assert.equal(safeStringEqual('abc', 'abc'), true);
});

test('safeStringEqual: different strings of same length → false', () => {
  assert.equal(safeStringEqual('abc', 'abd'), false);
});

test('safeStringEqual: different lengths → false', () => {
  assert.equal(safeStringEqual('abc', 'abcd'), false);
});

test('safeStringEqual: cyrillic input compares correctly', () => {
  assert.equal(safeStringEqual('парола', 'парола'), true);
  assert.equal(safeStringEqual('парола', 'паролб'), false);
});

test('safeStringEqual: non-string input → false (no throw)', () => {
  assert.equal(safeStringEqual(undefined, 'x'), false);
  assert.equal(safeStringEqual('x', null), false);
  assert.equal(safeStringEqual(123, 123), false);
});

// --------------------------------------------------------------------------
// todayLocalISO: Sofia timezone, format is YYYY-MM-DD
// --------------------------------------------------------------------------
test('todayLocalISO: returns YYYY-MM-DD format', () => {
  const v = todayLocalISO();
  assert.match(v, /^\d{4}-\d{2}-\d{2}$/);
});

test('todayLocalISO: matches Sofia local date regardless of process TZ', () => {
  // The implementation uses Intl.DateTimeFormat with timeZone: 'Europe/Sofia',
  // so this is independent of process.env.TZ.
  const expected = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  assert.equal(todayLocalISO(), expected);
});

// --------------------------------------------------------------------------
// auth rate limiter: lockout after N failures, reset on success, per-IP
// --------------------------------------------------------------------------
test('authRateLimiter: first attempt is allowed', () => {
  const ip = 'rate-test-1.' + Math.random();
  assert.equal(authRateCheck(ip).ok, true);
});

test('authRateLimiter: locks out after 5 failed attempts', () => {
  const ip = 'rate-test-2.' + Math.random();
  for (let i = 0; i < 5; i++) {
    assert.equal(authRateCheck(ip).ok, true, `attempt ${i + 1} should be allowed before lockout`);
    authRateRecord(ip, false);
  }
  const res = authRateCheck(ip);
  assert.equal(res.ok, false, '6th attempt should be blocked');
  assert.ok(res.retryAfterSec > 0 && res.retryAfterSec <= 60);
});

test('authRateLimiter: success resets counter', () => {
  const ip = 'rate-test-3.' + Math.random();
  for (let i = 0; i < 4; i++) authRateRecord(ip, false);
  authRateRecord(ip, true);  // success — reset
  // Five new failures should not trigger lockout (counter starts fresh).
  for (let i = 0; i < 4; i++) authRateRecord(ip, false);
  assert.equal(authRateCheck(ip).ok, true);
});

test('authRateLimiter: separate IPs are isolated', () => {
  const ipA = 'rate-test-4a.' + Math.random();
  const ipB = 'rate-test-4b.' + Math.random();
  for (let i = 0; i < 5; i++) authRateRecord(ipA, false);
  assert.equal(authRateCheck(ipA).ok, false);
  assert.equal(authRateCheck(ipB).ok, true);  // B is unaffected
});

// --------------------------------------------------------------------------
// writeData: backup link semantics — bak.1 is a complete prior file
// --------------------------------------------------------------------------
test('writeData: bak.1 holds the previous primary contents (not partial)', () => {
  const dataFile = path.join(TMP_ROOT, 'tennis.json');
  writeData({ players: ['linkA'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });
  writeData({ players: ['linkB'], results: {}, schedule: {}, live: {}, resultsRecordedAt: {} });
  const bak1 = JSON.parse(fs.readFileSync(dataFile + '.bak.1', 'utf-8'));
  // The previous primary's content must be fully readable — proves the
  // link/copy step uses a complete file, not a half-written one.
  assert.deepEqual(bak1.players, ['linkA']);
});

// --------------------------------------------------------------------------
// Cleanup
// --------------------------------------------------------------------------
test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});
