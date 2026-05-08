# CLAUDE.md — instructions for Claude Code on this project

This file is auto-loaded into every Claude Code session in this repo. The README is for humans; this file is for Claude.

## Pre-commit checklist

**Run through this before every `git commit`:**

### 1. Did I touch any PWA shell file? → bump `CACHE_VERSION` in `sw.js`

The service worker precaches a fixed list of files (the "shell"). When any of those files change, clients with the old cache will keep serving the old version until the SW updates. The SW only updates when its own bytes change — which we trigger by bumping the version constant.

**Note on HTTP cache busting:** The server automatically inserts `?v=<hash>` into asset URLs in HTML at startup (see `transformHtml` in server.js). This means non-PWA browsers also pick up new files automatically — they revalidate HTML (`must-revalidate, max-age=0`), get new HTML with new versioned URLs, and fetch fresh assets. So users without SW (and users still using old immutable-cached assets from prior deploys) get updates without hard refresh.

The CACHE_VERSION bump is for SW users — it forces SW reinstall and shell re-precache.

**Shell files** (precached in `sw.js` → `SHELL` array):
- `/index.html`
- `/styles.css`
- `/app.js`
- `/data.js`
- `/alpine.min.js`
- `/favicon.svg`
- `/apple-touch-icon.png`
- `/manifest.webmanifest`

If your commit modifies **any** of those, edit `sw.js` and bump the version:

```js
const CACHE_VERSION = 'tennis-v1';  // → 'tennis-v2'
```

The version naming is just a counter — keep it monotonic so it's obvious which is newer.

**Files that DON'T require a bump:**
- `server.js`, `Dockerfile`, `README.md`, `CLAUDE.md`, `seed.json` — never reach the browser as cached shell.
- `og.png`, `og.svg` — used by social previews, not by the SPA shell.
- `sw.js` itself — the bump IS the change; bumping itself counts as the change that ships.

If you forget to bump and ship a CSS/JS change: existing PWA users will see the old UI until they hard-refresh or until the browser eventually re-checks the SW (next navigation, after a few hours).

### 2. Did I add a new static asset that should be available offline?

If you added a file the SPA loads on first paint (e.g. a new font file, new icon, new JS module), add it to the `SHELL` array in `sw.js` AND bump the version.

If you added a file referenced lazily (e.g. an export-only icon used after a click), it'll still be cached the first time it's fetched via `stale-while-revalidate` — no shell update needed.

### 3. Did I add new files that need to be served? → update `Dockerfile`

The Dockerfile explicitly lists files copied into `public/`. Anything not listed there won't be served in production. Two `COPY` lines to inspect:

```dockerfile
COPY index.html styles.css app.js data.js alpine.min.js sw.js ./public/
COPY manifest.webmanifest og.png og.svg favicon.svg apple-touch-icon.png ./public/
```

### 4. Did I add a new API endpoint? → check key validation

All match-key-bearing endpoints **must** validate against `VALID_KEYS` (server.js). The whitelist is built from `MATCHES_SEED`. Existing endpoints that do this:
- `POST /api/match/<key>/live`
- `DELETE /api/match/<key>/live`
- `POST /api/match/<key>/result`
- `PUT /api/data` (validates all keys in `results`/`schedule`/`live`)

### 5. Did I change persisted data shape? → migration consideration

The data file at `/data/tennis.json` is shared across all clients. New fields are safe (server uses `|| {}` defaults). Removing or renaming fields requires a migration step in `readData()` in server.js.

### 6. Did I change a feature non-admin users use on match-day?

Two endpoints allow non-admin writes when `schedule[key]` is today:
- `POST /api/match/<key>/live` (live game-by-game scoring)
- `POST /api/match/<key>/result` (final set result)

Both auto-clean `schedule[key]` and `live[key]` on finalize. If you add a third non-admin endpoint, follow the same pattern: require `schedule[key]` to be today, clear schedule on success.

## Architecture quick reference (for code changes)

- **Single Alpine component** `tennisApp` in `app.js` — all state and methods live here.
- **Derived state** (`matches`, `standings`, etc.) is recomputed via `recomputeDerived()` triggered by `$watch('results')` and `$watch('schedule')`. Don't add getters that iterate over all matches — use derived state.
- **Canonical pair keys**: `"P1|P2"` where P1 comes before P2 in `PLAYERS`. Build keys from `match.key` (which comes from `MATCHES_SEED`), never from raw user input.
- **Mutation must reassign**: Alpine watchers fire on reassignment, not mutation. Use `this.results = { ...this.results, [key]: ... }`, not `this.results[key] = ...`.
- **Anti-loop flag**: `_fromServer = true` before applying server data, cleared in microtask. `persist()` bails if set.
- **Two-mode backend**: `backendMode = 'api'` (server) or `'local'` (localStorage). Detected at boot via `/api/health`. Same code runs in both.

## Things that are intentionally not done

Don't "fix" these without explicit user request:

- **No build step.** Files are served as authored. No bundler, no TS, no minification beyond what's already shipped.
- **No npm dependencies.** Server uses only Node built-ins. Adding `express` or similar is a no.
- **No SQL/Postgres.** Single JSON file. Don't suggest "scaling" the storage.
- **Plain-text admin password in env var.** Standard 12-factor; don't propose hashing without context.
- **Cyrillic in keys/strings everywhere.** UTF-8 is the source of truth. Don't transliterate.

## Local development

```powershell
$env:ADMIN_PASSWORD = "test123"
$env:DATA_DIR = "./data"   # avoid trying to create /data on Windows
node server.js
```

Note: server reads from `public/` by default. The Dockerfile builds that layout. For local dev that needs the static frontend (not just API), either copy files to `./public/` or open `index.html` directly via `file://` (frontend auto-detects and falls back to localStorage mode).

## When in doubt

Ask the user before:
- Bumping anything that changes user-facing behavior in a way they might not have anticipated.
- Removing existing data fields.
- Force-pushing or destructive git operations.
- Committing without explicit ask.
