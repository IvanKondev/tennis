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
  buildValidPairs,
  canonicalPair,
  validateTournament,
  validateArchive,
  validateRoster,
  clampInt,
  validateLiveBody,
  migratePlayerRename,
  migratePlayerDelete,
  safeStringEqual,
  todayLocalISO,
  scheduleStartMs,
  dueReminders,
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
// buildValidPairs: group-aware fixture set.
// --------------------------------------------------------------------------
const GROUPED = {
  players: ['Сашо', 'Белев', 'Иво', 'Емо', 'Лебанов', 'Никата', 'Нако', 'Гого', 'Вики', 'Моцко'],
  tournament: {
    name: 'Турнир лято 2026',
    groups: [
      { name: 'Група 1', players: ['Сашо', 'Белев', 'Иво', 'Емо', 'Лебанов'] },
      { name: 'Група 2', players: ['Никата', 'Нако', 'Гого', 'Вики', 'Моцко'] }
    ],
    extraPairs: []
  }
};

test('buildValidPairs: 2 groups of 5 → 20 fixtures, not 45', () => {
  const set = buildValidPairs(GROUPED);
  assert.equal(set.size, 20);           // 2 × C(5,2), NOT C(10,2) = 45
});

test('buildValidPairs: within-group pairs are valid', () => {
  const set = buildValidPairs(GROUPED);
  assert.ok(set.has('Сашо|Белев'));
  assert.ok(set.has('Иво|Лебанов'));
  assert.ok(set.has('Никата|Моцко'));
});

test('buildValidPairs: cross-group pairs are NOT fixtures', () => {
  const set = buildValidPairs(GROUPED);
  assert.ok(!set.has('Сашо|Никата'));
  assert.ok(!set.has('Емо|Гого'));
});

test('buildValidPairs: keys stay canonical (roster order), not group order', () => {
  const set = buildValidPairs(GROUPED);
  // Сашо is index 0, Иво index 2 → "Сашо|Иво". Reverse must be rejected.
  assert.ok(set.has('Сашо|Иво'));
  assert.ok(!set.has('Иво|Сашо'));
});

test('buildValidPairs: extraPairs add the knockout stage without code changes', () => {
  const withFinal = {
    ...GROUPED,
    tournament: { ...GROUPED.tournament, extraPairs: ['Сашо|Никата'] }
  };
  const set = buildValidPairs(withFinal);
  assert.equal(set.size, 21);
  assert.ok(set.has('Сашо|Никата'));
});

test('buildValidPairs: extraPairs get canonicalized', () => {
  const withFinal = {
    ...GROUPED,
    // Supplied in the wrong order — must be stored canonically.
    tournament: { ...GROUPED.tournament, extraPairs: ['Никата|Сашо'] }
  };
  const set = buildValidPairs(withFinal);
  assert.ok(set.has('Сашо|Никата'));
  assert.ok(!set.has('Никата|Сашо'));
});

test('buildValidPairs: no tournament → falls back to full round-robin', () => {
  const flat = { players: ['A', 'B', 'C'], tournament: null };
  const set = buildValidPairs(flat);
  assert.equal(set.size, 3);
  assert.ok(set.has('A|B'));
});

test('buildValidPairs: tournament without groups → full round-robin', () => {
  const flat = { players: ['A', 'B', 'C'], tournament: { name: 'X', groups: null, extraPairs: [] } };
  assert.equal(buildValidPairs(flat).size, 3);
});

test('canonicalPair: orders by roster index, null for unknown names', () => {
  const roster = ['A', 'B', 'C'];
  assert.equal(canonicalPair(roster, 'C', 'A'), 'A|C');
  assert.equal(canonicalPair(roster, 'A', 'C'), 'A|C');
  assert.equal(canonicalPair(roster, 'A', 'Z'), null);
  assert.equal(canonicalPair(roster, 'A', 'A'), null);
});

// --------------------------------------------------------------------------
// validateTournament / validateArchive
// --------------------------------------------------------------------------
test('validateTournament: null is a valid (flat) tournament', () => {
  const r = validateTournament(null, ['A', 'B']);
  assert.equal(r.ok, true);
  assert.equal(r.tournament, null);
});

test('validateTournament: rejects a group player who is not on the roster', () => {
  const r = validateTournament(
    { name: 'T', groups: [{ name: 'G1', players: ['A', 'Z'] }] },
    ['A', 'B']
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /not on roster/);
});

test('validateTournament: rejects a player listed in two groups', () => {
  const r = validateTournament({
    name: 'T',
    groups: [
      { name: 'G1', players: ['A', 'B'] },
      { name: 'G2', players: ['B', 'C'] }
    ]
  }, ['A', 'B', 'C']);
  assert.equal(r.ok, false);
  assert.match(r.error, /two groups/);
});

test('validateTournament: requires a name', () => {
  assert.equal(validateTournament({ groups: [] }, ['A', 'B']).ok, false);
});

test('validateArchive: accepts a snapshot keyed by its OWN roster', () => {
  // "Иво|Сашо" is canonical under the archived 21-player order even though the
  // active roster would canonicalize it the other way. Must still validate.
  const r = validateArchive([{
    id: 'spring-2026',
    name: 'Турнир пролет 2026',
    players: ['Иво', 'Сашо'],
    results: { 'Иво|Сашо': [0, 2] }
  }]);
  assert.equal(r.ok, true);
  assert.equal(r.archive[0].results['Иво|Сашо'][1], 2);
});

test('validateArchive: rejects a result key not derivable from its roster', () => {
  const r = validateArchive([{
    id: 'x', name: 'X', players: ['A', 'B'], results: { 'A|Z': [2, 0] }
  }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid result key/);
});

test('validateArchive: rejects duplicate ids', () => {
  const entry = { id: 'x', name: 'X', players: ['A', 'B'], results: {} };
  const r = validateArchive([entry, { ...entry }]);
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate archive id/);
});

test('validateRoster: rejects "|" in a name and duplicates', () => {
  assert.equal(validateRoster(['A|B', 'C']).ok, false);
  assert.equal(validateRoster(['A', 'A']).ok, false);
  assert.equal(validateRoster(['A', 'B']).ok, true);
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
// Player migrations vs. tournament format and frozen history.
// --------------------------------------------------------------------------
function groupedFixture() {
  return {
    players: ['A', 'B', 'C', 'D'],
    tournament: {
      name: 'T',
      groups: [
        { name: 'G1', players: ['A', 'B'] },
        { name: 'G2', players: ['C', 'D'] }
      ],
      extraPairs: ['A|C']
    },
    results: { 'A|B': [2, 0] },
    schedule: {},
    live: {},
    resultsRecordedAt: { 'A|B': 't1' },
    archive: [{
      id: 'old', name: 'Old', players: ['A', 'B'], results: { 'A|B': [0, 2] }, resultsRecordedAt: {}
    }]
  };
}

test('migratePlayerRename: renames inside tournament groups and extraPairs', () => {
  const out = migratePlayerRename(groupedFixture(), 'A', 'Z');
  assert.deepEqual(out.tournament.groups[0].players, ['Z', 'B']);
  assert.deepEqual(out.tournament.groups[1].players, ['C', 'D']);
  assert.deepEqual(out.tournament.extraPairs, ['Z|C']);
});

test('migratePlayerRename: leaves the archive frozen', () => {
  const out = migratePlayerRename(groupedFixture(), 'A', 'Z');
  // History records who actually played — renaming today must not rewrite it.
  assert.deepEqual(out.archive[0].players, ['A', 'B']);
  assert.deepEqual(Object.keys(out.archive[0].results), ['A|B']);
});

test('migratePlayerDelete: removes player from their group and drops extraPairs', () => {
  const out = migratePlayerDelete(groupedFixture(), 'A');
  assert.deepEqual(out.tournament.groups[0].players, ['B']);
  assert.deepEqual(out.tournament.extraPairs, []);
  assert.equal(out.results['A|B'], undefined);
});

test('migratePlayerDelete: leaves the archive frozen', () => {
  const out = migratePlayerDelete(groupedFixture(), 'A');
  assert.deepEqual(out.archive[0].players, ['A', 'B']);
  assert.deepEqual(out.archive[0].results, { 'A|B': [0, 2] });
});

test('migratePlayer*: no-op on tournament when there is none', () => {
  const flat = { ...fixture(), tournament: null };
  assert.equal(migratePlayerRename(flat, 'A', 'Z').tournament, null);
  assert.equal(migratePlayerDelete(flat, 'A').tournament, null);
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
// scheduleStartMs: Sofia wall-clock string -> UTC epoch (DST-aware)
// --------------------------------------------------------------------------
test('scheduleStartMs: returns null for malformed input', () => {
  assert.equal(scheduleStartMs(''), null);
  assert.equal(scheduleStartMs(null), null);
  assert.equal(scheduleStartMs('2026-05-21'), null);     // no time component
  assert.equal(scheduleStartMs('not-a-date'), null);
});

test('scheduleStartMs: summer time (EEST, UTC+3) — 18:00 Sofia = 15:00 UTC', () => {
  // 2026-05-21 is during daylight saving in Sofia (UTC+3).
  const ms = scheduleStartMs('2026-05-21T18:00');
  assert.equal(new Date(ms).toISOString(), '2026-05-21T15:00:00.000Z');
});

test('scheduleStartMs: winter time (EET, UTC+2) — 18:00 Sofia = 16:00 UTC', () => {
  // 2026-01-15 is standard time in Sofia (UTC+2).
  const ms = scheduleStartMs('2026-01-15T18:00');
  assert.equal(new Date(ms).toISOString(), '2026-01-15T16:00:00.000Z');
});

// --------------------------------------------------------------------------
// dueReminders: two one-shot stages per match — 'lead' (T-10min) and 'start' (T0)
// --------------------------------------------------------------------------
const LEAD = 10 * 60 * 1000;

test('dueReminders: lead stage fires in [start-10min, start)', () => {
  const start = scheduleStartMs('2026-05-21T18:00');
  const data = { schedule: { 'A|B': '2026-05-21T18:00' }, reminderSent: {}, live: {}, results: {} };
  assert.deepEqual(dueReminders(data, start - 11 * 60 * 1000, LEAD), []);                    // 11 min before: nothing
  assert.deepEqual(dueReminders(data, start - LEAD, LEAD), [{ key: 'A|B', stage: 'lead' }]); // exactly 10
  assert.deepEqual(dueReminders(data, start - 60 * 1000, LEAD), [{ key: 'A|B', stage: 'lead' }]); // 1 min before
});

test('dueReminders: start stage fires in [start, start+10min)', () => {
  const start = scheduleStartMs('2026-05-21T18:00');
  const data = { schedule: { 'A|B': '2026-05-21T18:00' }, reminderSent: {}, live: {}, results: {} };
  assert.deepEqual(dueReminders(data, start, LEAD), [{ key: 'A|B', stage: 'start' }]);
  assert.deepEqual(dueReminders(data, start + 60 * 1000, LEAD), [{ key: 'A|B', stage: 'start' }]);
  assert.deepEqual(dueReminders(data, start + LEAD, LEAD), []); // too late -> stale, skipped
});

test('dueReminders: each stage fires only once', () => {
  const start = scheduleStartMs('2026-05-21T18:00');
  const data = {
    schedule: { 'A|B': '2026-05-21T18:00' },
    reminderSent: { 'A|B': { at: '2026-05-21T18:00', lead: true } },
    live: {}, results: {}
  };
  // lead already sent -> nothing in the lead window
  assert.deepEqual(dueReminders(data, start - 5 * 60 * 1000, LEAD), []);
  // start still pending -> fires at start time
  assert.deepEqual(dueReminders(data, start + 60 * 1000, LEAD), [{ key: 'A|B', stage: 'start' }]);
  // both sent -> nothing
  data.reminderSent['A|B'].start = true;
  assert.deepEqual(dueReminders(data, start + 60 * 1000, LEAD), []);
});

test('dueReminders: missed lead window still fires start (no late lead spam)', () => {
  const start = scheduleStartMs('2026-05-21T18:00');
  // Server was down through the whole lead window; first tick is past start.
  const data = { schedule: { 'A|B': '2026-05-21T18:00' }, reminderSent: {}, live: {}, results: {} };
  assert.deepEqual(dueReminders(data, start + 60 * 1000, LEAD), [{ key: 'A|B', stage: 'start' }]);
});

test('dueReminders: re-arms both stages when rescheduled to a new time', () => {
  const start = scheduleStartMs('2026-05-21T20:00');
  const data = {
    schedule: { 'A|B': '2026-05-21T20:00' },                               // new time
    reminderSent: { 'A|B': { at: '2026-05-21T18:00', lead: true, start: true } }, // flags from old time
    live: {}, results: {}
  };
  assert.deepEqual(dueReminders(data, start - 5 * 60 * 1000, LEAD), [{ key: 'A|B', stage: 'lead' }]);
});

test('dueReminders: skips matches already live or finished', () => {
  const start = scheduleStartMs('2026-05-21T18:00');
  const now = start - 5 * 60 * 1000;
  const liveData = { schedule: { 'A|B': '2026-05-21T18:00' }, reminderSent: {}, live: { 'A|B': {} }, results: {} };
  const doneData = { schedule: { 'A|B': '2026-05-21T18:00' }, reminderSent: {}, live: {}, results: { 'A|B': [2, 0] } };
  assert.deepEqual(dueReminders(liveData, now, LEAD), []);
  assert.deepEqual(dueReminders(doneData, now, LEAD), []);
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
