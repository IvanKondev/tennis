# CLAUDE.md — instructions for Claude Code on this project

This file is auto-loaded into every Claude Code session in this repo. The README is for humans; this file is for Claude.

## Pre-commit checklist

**Run through this before every `git commit`:**

### 1. Cache version is auto-derived — no manual bump

The server replaces `__CACHE_VERSION__` in `sw.js` at boot with a hash of every shell file's content (see `preloadPublicDir` phase 3 in `server.js`). Any change to a shell file → different hash → different `sw.js` bytes → browser installs a new SW automatically. **You do not need to bump anything manually.**

**Non-PWA users** also get updates automatically: server inserts `?v=<hash>` into asset URLs in HTML at startup; browsers revalidate HTML (`must-revalidate, max-age=0`) and pick up the new versioned URLs.

**Shell files** (auto-versioned via the hash):
- `/index.html`
- `/styles.css`
- `/app.js`
- `/data.js`
- `/alpine.min.js`
- `/favicon.svg`
- `/apple-touch-icon.png`
- `/manifest.webmanifest`

If you add a NEW file that should count as part of the shell, add its filename to the `shellNames` set in `preloadPublicDir` (server.js).

### 2. Did I add a new static asset that should be available offline at first paint?

The SW precaches only stable-URL files: `/`, `/index.html`, `/favicon.svg`, `/apple-touch-icon.png`, `/manifest.webmanifest`. All other static assets are fetched lazily on first request and cached (stale-while-revalidate).

If you add a NEW stable-URL file that must be in the offline shell, add it to the `SHELL` array in `sw.js` AND to the `shellNames` set in server.js (so the version hash reflects it).

### 3. Did I add new files that need to be served? → update `Dockerfile`

The Dockerfile explicitly lists files copied into `public/`. Anything not listed there won't be served in production. Two `COPY` lines to inspect:

```dockerfile
COPY index.html styles.css app.js data.js alpine.min.js sw.js ./public/
COPY manifest.webmanifest og.png og.svg favicon.svg apple-touch-icon.png ./public/
```

### 4. Did I add a new API endpoint? → check key validation + audit

All match-key-bearing endpoints **must** validate against `buildValidPairs(data)` (server.js) — **not** `buildValidKeys(players)`. `buildValidPairs` is tournament-format aware: with a group split it only allows within-group pairs (plus `tournament.extraPairs`), so a cross-group result is a 404. `buildValidKeys` is the flat round-robin primitive it falls back to; use it directly only for archived snapshots. Existing endpoints that validate:
- `POST /api/match/<key>/live`
- `DELETE /api/match/<key>/live`
- `POST /api/match/<key>/result`
- `PUT /api/data` (validates all keys in `results`/`schedule`/`live`/`resultsRecordedAt`)
- `POST /api/players` (admin-only, name validation: non-empty, ≤40 chars, no `|`, unique)

Push-notification endpoints (no key validation needed — they store browser subscriptions, not match data):
- `GET /api/push/vapid-public-key` (public; 404 if push disabled)
- `POST /api/push/subscribe` (public; idempotent by endpoint)
- `POST /api/push/unsubscribe` (public; idempotent)

**Admin authentication**: use `checkAdmin(req)` which prefers session token (`X-Admin-Token` header) over plaintext password (`X-Admin-Password` — kept for transitional backward-compat only). Tokens are issued by `POST /api/auth` and revoked by `DELETE /api/auth`. Don't write new endpoints that accept the password header directly.

**Audit log**: every successful admin mutation **must** call `audit(req, '<action>', { ... })`. Lines go to `<DATA_DIR>/audit.jsonl` and are the forensic record. Action names follow `<noun>.<verb>` (e.g. `player.delete`, `match.finalize`).

### 5. Did I change persisted data shape? → migration consideration

The data file at `/data/tennis.json` is shared across all clients. New fields are safe (server uses `|| {}` defaults). Removing or renaming fields requires a migration step in `readData()` in server.js.

### 5a. Tournament format + history

Two top-level fields carry the tournament structure:

```jsonc
"tournament": {                      // null = flat round-robin over the whole roster
  "name": "Турнир лято 2026",
  "groups": [                        // null/absent = no group split
    { "name": "Група 1", "players": ["Сашо","Белев","Иво","Емо","Лебанов"] },
    { "name": "Група 2", "players": ["Никата","Нако","Гого","Вики","Моцко"] }
  ],
  "extraPairs": []                   // knockout fixtures outside the group stage
},
"archive": [ { "id", "name", "endedAt", "players", "results", "resultsRecordedAt", "groups" } ]
```

- **Fixtures = within-group pairs ∪ `extraPairs`.** Starting the winners' final is a *data* change (append `"Сашо|Никата"` to `extraPairs`), never a code change.
- **Standings are per group and rank within the group.** Only `stage: 'group'` matches count — a knockout result doesn't move a group table. See `computeStandings()` / `buildMatches()` at the top of `app.js` (module scope, so the history view reuses them verbatim).
- **Every view that lists opponents must go through `rosterFor(name)`**, not `this.players`. Iterating the full roster makes cross-group players show up as unplayed fixtures that don't exist. Call sites: `duelOpponents`, `duelOpponentsGrouped`, `h2hRowSummary`, `wizardOpponents`, `duelProgressRate/Label`.
- **`archive` is frozen.** Each snapshot carries its **own** `players` array, because canonical key order depends on roster position — `"Иво|Сашо"` is correct under last season's 21-player list even though today's roster would canonicalize it as `"Сашо|Иво"`. `migratePlayerRename`/`migratePlayerDelete` rewrite `tournament` but **never** touch `archive`.
- **`PUT /api/data` is also the Import/restore path.** `players`, `tournament` and `archive` are optional: omitted → inherited from disk (normal score write); supplied → full replacement, validated by `validateRoster` / `validateTournament` / `validateArchive`.
- **`POST /api/players` requires `group`** when a split is active, else the new player lands on the roster with zero possible fixtures.

Switching tournaments is a **manual, explicit** operation — export, transform, import. There is no "end tournament" button and no implicit migration on load.

### 6. Did I change a feature non-admin users use on match-day?

Two endpoints allow non-admin writes when `schedule[key]` is today:
- `POST /api/match/<key>/live` (live game-by-game scoring)
- `POST /api/match/<key>/result` (final set result)

Both auto-clean `schedule[key]` and `live[key]` on finalize. If you add a third non-admin endpoint, follow the same pattern: require `schedule[key]` to be today, clear schedule on success.

## Architecture quick reference (for code changes)

- **Single Alpine component** `tennisApp` in `app.js` — all state and methods live here. Exception: `tournamentPairs` / `buildMatches` / `computeStandings` sit at module scope above it, so the same code computes the live tournament and any archived snapshot.
- **Derived state** (`matches`, `standings`, etc.) is recomputed via `recomputeDerived()` triggered by `$watch('results')` and `$watch('schedule')`. Don't add getters that iterate over all matches — use derived state.
- **Player roster lives in `/data/tennis.json`** (`data.players` field). `data.js`'s `PLAYERS` array is only a bootstrap default used when the data file has no `players` field yet. The admin "Add player" UI POSTs to `/api/players`; the server is authoritative. `MATCHES_SEED` in `data.js` is similarly bootstrap-only — match pairs are generated dynamically from `this.players` in `recomputeDerived`.
- **Canonical pair keys**: `"P1|P2"` where P1 comes before P2 in the player list. Build keys from `match.key`, never from raw user input. Server validates incoming keys against `buildValidPairs(data)` on every write.
- **Mutation must reassign**: Alpine watchers fire on reassignment, not mutation. Use `this.results = { ...this.results, [key]: ... }`, not `this.results[key] = ...`.
- **Anti-loop flag**: `_fromServer = true` before applying server data, cleared in microtask. `persist()` bails if set.
- **Two-mode backend**: `backendMode = 'api'` (server) or `'local'` (localStorage). Detected at boot via `/api/health`. Same code runs in both.

## Operational scale

Calibrate any architectural suggestion against the real numbers — this is a hobby league, not SaaS:

- **Tournament size**: max 40–50 players per tournament. Round-robin → up to ~1225 matches total over the tournament's lifetime.
- **Daily traffic**: max 4–5 matches/day during active periods. Live-scoring concurrency is single-digit at peak (one ongoing match at a time, occasionally two).
- **Data file size**: the JSON stays under ~150 KB even at full scale. No reason to migrate to SQLite/Postgres.
- **Single admin** (occasionally a small handful). Multi-user RBAC is overkill.
- **Single host** on Coolify. No HA / no replicas. RPO target: yesterday's off-site backup. RTO target: ~30 min manual restore.

When tempted to add infra "for scale" — reread the numbers above. If the change isn't justified at 50 players × 5 matches/day, don't ship it.

## Things that are intentionally not done

Don't "fix" these without explicit user request — each was a deliberate scale-vs-complexity tradeoff:

- **No build step.** Files served as authored. No bundler, no TS, no minification beyond what's shipped.
- **One npm dependency: `web-push`.** Required for VAPID-encrypted Web Push (RFC 8291) — hand-rolling that crypto correctly is a multi-hundred-LOC project, so the single battle-tested dep is the pragmatic call. Don't add others (no `express` etc.). Push fires from `/api/match/<key>/live` (start, set-complete, auto-finalize) and `/api/match/<key>/result` (manual finalize) via `sendPushToAll()`. Subscriptions live in `data.pushSubscriptions[]`. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` env vars (see `.env.example`); without them push silently disables and the bell UI hides.
- **No SQL/Postgres.** Single JSON file is correct at this scale (≤150 KB). Don't suggest "scaling" the storage.
- **Plain-text admin password in env var** (paired with timing-safe compare server-side and short-lived session token client-side — never the password itself in storage). Standard 12-factor.
- **No multi-user / RBAC.** One shared admin role is the right size for a hobby league.
- **Polling, not WebSocket/SSE.** 5–10 s lag is fine for casual live scoring; real-time push is not worth the ops complexity.
- **Push UI is a single pill button (`.push-bell` in styles.css), not a settings panel.** State is reflected by label+color, not iconography alone (🔕 was confusing). Off-state pulses 3× to draw attention; subscribed-state collapses to compact `✓ ВКЛ` on mobile so it doesn't fight the hero title.
- **Cyrillic in keys/strings everywhere.** UTF-8 is the source of truth. Don't transliterate.
- **No staging environment.** Small PRs + tested rollback path is sufficient at this scale.

## Local development

```powershell
$env:ADMIN_PASSWORD = "test123"
$env:DATA_DIR = "./data"   # avoid trying to create /data on Windows
node server.js
# (or just create .env from .env.example — server auto-loads it at boot)
```

## Tests

Two suites, both using Node's built-in `node:test` (no npm deps):

- `test/server.test.js` — pure helpers + readData/writeData round-trips. Covers: `buildValidKeys`, `clampInt`, `validateLiveBody`, `migratePlayerRename`, `migratePlayerDelete`, `safeStringEqual`, `todayLocalISO`, `authRateCheck`/`Record`, backup rotation, EBADJSON behavior.
- `test/http.test.js` — HTTP integration: binds the server to an ephemeral port and exercises real handler glue. Covers: `/api/health`, `/api/version`, `/api/auth` (wrong/correct/invalid-json/token-revoke), `/api/players` (validation, cyrillic), `/api/match/<key>/result` (admin/non-admin/invalid score/unknown pair), security headers.

```powershell
npm test          # runs both suites
```

When adding a new pure helper or migration function, add a `server.test.js` test alongside it. When adding a new HTTP handler, add an `http.test.js` test exercising the happy path + at least one error case.

Note: server reads from `public/` by default. The Dockerfile builds that layout. For local dev that needs the static frontend (not just API), either copy files to `./public/` or open `index.html` directly via `file://` (frontend auto-detects and falls back to localStorage mode).

## Real data — no silent migrations or backfills

There is **one** data file: `/data/tennis.json` on the production server. It is real, live data — not a fixture. Treat it accordingly:

- **Never auto-mutate persisted user data on load.** No init-time backfills, no "fix-up" passes, no rewriting of `resultsRecordedAt`, `results`, `schedule`, `live`, or any other field as a side effect of opening the page. A getter that reshapes data for display is fine; a side effect that calls `persist()` / `persistLocal()` to write derived guesses back is not.
- **Don't fabricate timestamps.** If a record is missing `recordedAt`, the honest UI is "no date" — not `new Date().toISOString()`. We learned this the hard way: a backfill stamped two yesterday-entered results with today's ISO and the originals are unrecoverable.
- **Migrations require explicit ask.** If schema changes truly demand reshaping existing data, propose it to the user first with a clear before/after and a backup plan. Do not ship migration logic that runs implicitly.
- **Reads are free, writes are not.** Computing a different view of the data in a getter (filter, group, sort, label) is always preferred over rewriting the underlying state.

## When in doubt

Ask the user before:
- Bumping anything that changes user-facing behavior in a way they might not have anticipated.
- Removing existing data fields.
- Force-pushing or destructive git operations.
- Committing without explicit ask.
