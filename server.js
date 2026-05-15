const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { PLAYERS } = require('./data.js');

// Tiny .env loader — only KEY=VALUE lines, no quoting, no expansion. Avoids
// the dotenv dep. Existing process.env values win (so docker/coolify env
// stays authoritative in prod).
(function loadDotEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
})();

const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'tennis.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Structured JSON-line logger. One line per event written to stdout, easy to
// grep / pipe into any log aggregator. No npm deps. Format:
//   {"ts":"…","level":"info","msg":"…", ...}
function logEvent(level, msg, fields) {
  const rec = { ts: new Date().toISOString(), level, msg };
  if (fields && typeof fields === 'object') Object.assign(rec, fields);
  // stderr for warn/error so docker/k8s can split streams; stdout otherwise.
  const out = (level === 'warn' || level === 'error') ? process.stderr : process.stdout;
  out.write(JSON.stringify(rec) + '\n');
}
const log = {
  info:  (msg, fields) => logEvent('info', msg, fields),
  warn:  (msg, fields) => logEvent('warn', msg, fields),
  error: (msg, fields) => logEvent('error', msg, fields)
};

if (!ADMIN_PASSWORD) {
  log.warn('ADMIN_PASSWORD not set — admin writes are disabled');
}

// Canonical match keys are derived from the current player list, NOT a static
// MATCHES_SEED — players can be added at runtime via POST /api/players.
function buildValidKeys(players) {
  const set = new Set();
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      set.add(players[i] + '|' + players[j]);
    }
  }
  return set;
}

// Pure data transforms for player rename / delete. The HTTP handlers call
// these inside their atomic critical section; tests exercise them directly.
//
// Rename preserves the player's index in the list, so "P1|P2" canonical key
// ordering is stable — only the substring swaps. Delete cascades through all
// four maps to remove every match the player participated in.
function migratePlayerRename(data, oldName, newName) {
  const renameKey = (k) => {
    const [a, b] = k.split('|');
    if (a === oldName) return newName + '|' + b;
    if (b === oldName) return a + '|' + newName;
    return k;
  };
  const remap = (obj) => {
    const out = {};
    for (const k in obj) out[renameKey(k)] = obj[k];
    return out;
  };
  return {
    ...data,
    players: data.players.map(p => p === oldName ? newName : p),
    results: remap(data.results),
    schedule: remap(data.schedule),
    live: remap(data.live),
    resultsRecordedAt: remap(data.resultsRecordedAt)
  };
}

function migratePlayerDelete(data, name) {
  const involves = (k) => {
    const [a, b] = k.split('|');
    return a === name || b === name;
  };
  const filterKeys = (obj) => {
    const out = {};
    for (const k in obj) if (!involves(k)) out[k] = obj[k];
    return out;
  };
  return {
    ...data,
    players: data.players.filter(p => p !== name),
    results: filterKeys(data.results),
    schedule: filterKeys(data.schedule),
    live: filterKeys(data.live),
    resultsRecordedAt: filterKeys(data.resultsRecordedAt)
  };
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ results: {}, schedule: {}, live: {}, resultsRecordedAt: {} }, null, 2));
  log.info('init: created empty data file', { path: DATA_FILE });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2'
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json', '.webmanifest']);

// Build version exposed via /api/version. Set in preloadPublicDir phase 3
// to a content hash of all shell files; falls back to 'unknown' if sw.js
// wasn't found (e.g. test environments without public/).
let CACHE_VERSION = 'unknown';

// ===== File cache (loaded into memory at startup) =====
const fileCache = new Map();

function loadIntoCache(filePath, contentOverride) {
  try {
    const content = contentOverride || fs.readFileSync(filePath);
    const etag = '"' + crypto.createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
    const ext = path.extname(filePath).toLowerCase();
    const entry = { content, etag, ext };
    if (COMPRESSIBLE.has(ext) && content.length > 1024) {
      entry.gzipped = zlib.gzipSync(content, { level: 9 });
      // Brotli for clients that accept it. Quality 11 (max) is fine here —
      // we compress once at startup, never per-request.
      entry.brotli = zlib.brotliCompressSync(content, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
      });
    }
    fileCache.set(filePath, entry);
    return entry;
  } catch (e) { return null; }
}

// Inject ?v=<hash> into asset URLs inside HTML so browsers automatically
// fetch fresh versions when shell files change. Critical for users without
// the ability to hard-refresh (iOS Safari, non-technical visitors). Old
// HTTP-cached assets become unreferenced; the browser fetches the new
// versioned URL on its own.
function transformHtml(buf) {
  let html = buf.toString('utf-8');
  // Iterate every cached file and rewrite quoted refs in HTML.
  for (const [fp, ent] of fileCache) {
    const fname = path.basename(fp);
    // sw.js MUST keep its original URL — service worker registration is by URL,
    // and the browser's SW update flow handles its own cache busting.
    if (fname === 'sw.js') continue;
    if (fname === 'index.html') continue;
    const v = ent.etag.replace(/"/g, '').slice(0, 8);
    // Only replace inside double-quoted attribute values to avoid touching
    // text content or comments. e.g. href="styles.css" → href="styles.css?v=abcd".
    const needle = '"' + fname + '"';
    const replacement = '"' + fname + '?v=' + v + '"';
    html = html.split(needle).join(replacement);
  }
  return Buffer.from(html, 'utf-8');
}

function preloadPublicDir() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    log.info('cache: preloaded 0 static files (no public dir)');
    return;
  }
  // Collect all files first; load HTML last so its references know the
  // versions of every other asset.
  const all = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else all.push(full);
    }
  };
  walk(PUBLIC_DIR);
  // Phase 1: every non-HTML file
  for (const f of all) {
    if (path.extname(f).toLowerCase() !== '.html') loadIntoCache(f);
  }
  // Phase 2: HTML, with asset URL versioning baked in
  for (const f of all) {
    if (path.extname(f).toLowerCase() === '.html') {
      const raw = fs.readFileSync(f);
      const transformed = transformHtml(raw);
      loadIntoCache(f, transformed);
    }
  }
  // Phase 3: substitute CACHE_VERSION placeholder in sw.js with a hash
  // derived from every shell file's content. Any shell change → different
  // hash → different sw.js bytes → browser installs new service worker
  // automatically. No manual counter to forget.
  const swPath = path.join(PUBLIC_DIR, 'sw.js');
  if (fs.existsSync(swPath)) {
    const shellNames = new Set([
      'index.html', 'styles.css', 'app.js', 'data.js', 'alpine.min.js',
      'manifest.webmanifest', 'favicon.svg', 'apple-touch-icon.png'
    ]);
    const h = crypto.createHash('md5');
    for (const fp of [...fileCache.keys()].sort()) {
      const fname = path.basename(fp);
      if (shellNames.has(fname)) {
        h.update(fname);
        h.update(fileCache.get(fp).etag);
      }
    }
    CACHE_VERSION = 'tennis-' + h.digest('hex').slice(0, 12);
    const raw = fs.readFileSync(swPath, 'utf-8');
    const transformed = Buffer.from(raw.replace('__CACHE_VERSION__', CACHE_VERSION), 'utf-8');
    loadIntoCache(swPath, transformed);
    log.info('cache: sw.js auto-versioned', { cacheVersion: CACHE_VERSION });
  }
  log.info('cache: preloaded static files', { count: fileCache.size });
}

preloadPublicDir();

// Reads data from disk. Throws on parse failure — the caller MUST handle that
// rather than silently get a default {}, otherwise the next writeData would
// overwrite a corrupt-but-recoverable file with an empty state, losing data.
function readData() {
  let raw;
  try { raw = fs.readFileSync(DATA_FILE, 'utf-8'); }
  catch (e) {
    // Missing file is fine: ensureDataFileExists creates it at startup.
    if (e.code === 'ENOENT') raw = '{}';
    else throw e;
  }
  let d;
  try { d = JSON.parse(raw); }
  catch (e) {
    const err = new Error('data file is corrupt: ' + e.message);
    err.code = 'EBADJSON';
    throw err;
  }
  if (!d.results) d.results = {};
  if (!d.schedule) d.schedule = {};
  if (!d.live) d.live = {};
  if (!d.resultsRecordedAt) d.resultsRecordedAt = {};
  if (!Array.isArray(d.players) || d.players.length === 0) d.players = PLAYERS.slice();
  if (!Array.isArray(d.pushSubscriptions)) d.pushSubscriptions = [];
  return d;
}

// ===== Web Push =====
//
// VAPID-authenticated push to the browser's push service (FCM/Mozilla/Apple).
// Subscriptions are stored in tennis.json under `pushSubscriptions` keyed by
// the unique endpoint URL. Stale subscriptions (410 Gone / 404) are pruned
// lazily after each send. Push send is fire-and-forget — request handlers
// never await it, so a slow push service can't block live-scoring response.
let webpush = null;
let pushEnabled = false;
try {
  webpush = require('web-push');
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    pushEnabled = true;
  } else {
    log.warn('push: VAPID keys not set — push notifications disabled');
  }
} catch (e) {
  log.warn('push: web-push module not available — push disabled', { err: e.message });
}

// Remove subscriptions whose endpoint matches one of `deadEndpoints`. Persists
// only if anything changed. Called from sendPushToAll after a batch.
function pruneSubscriptions(deadEndpoints) {
  if (!deadEndpoints || deadEndpoints.size === 0) return;
  const data = readData();
  const before = data.pushSubscriptions.length;
  data.pushSubscriptions = data.pushSubscriptions.filter(s => !deadEndpoints.has(s.endpoint));
  if (data.pushSubscriptions.length !== before) {
    writeData(data);
    log.info('push: pruned dead subscriptions', { removed: before - data.pushSubscriptions.length });
  }
}

// Send a notification to every current subscriber. Fire-and-forget: returns
// a promise that the caller can ignore. Payload should be a small object —
// stringified to JSON, decrypted by the SW push handler.
function sendPushToAll(payload) {
  if (!pushEnabled) return Promise.resolve();
  const subs = readData().pushSubscriptions;
  if (subs.length === 0) return Promise.resolve();
  const body = JSON.stringify(payload);
  const dead = new Set();
  return Promise.all(subs.map(sub =>
    webpush.sendNotification(sub, body, { TTL: 3600 }).catch(err => {
      // 410 Gone or 404 → subscription is permanently dead.
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        dead.add(sub.endpoint);
      } else {
        log.warn('push: send failed', { endpoint: sub.endpoint.slice(0, 60), status: err && err.statusCode, err: err && err.message });
      }
    })
  )).then(() => pruneSubscriptions(dead));
}

// Build a human-friendly notification payload for a match event. The two
// player names come from the canonical key "P1|P2".
function matchPushPayload(eventType, key, extra) {
  const [p1, p2] = key.split('|');
  let title, body;
  if (eventType === 'match.start') {
    title = '🎾 Започна мач';
    body = `${p1} срещу ${p2}`;
  } else if (eventType === 'set.complete') {
    const setNum = extra && extra.setNumber;
    const score = extra && extra.setScore;
    title = `✓ Сет ${setNum}: ${score ? score[0] + '-' + score[1] : ''}`;
    body = `${p1} срещу ${p2}`;
  } else if (eventType === 'match.finish') {
    const r = extra && extra.result;
    title = '🏆 Краен резултат';
    body = `${p1} ${r ? r[0] : '?'}-${r ? r[1] : '?'} ${p2}`;
  } else {
    title = 'Tennis';
    body = `${p1} vs ${p2}`;
  }
  return { type: eventType, key, title, body, ts: new Date().toISOString() };
}

// Tournament timezone — non-admin "is this match scheduled for TODAY?" checks
// must use Sofia time regardless of the host process's TZ env. Hard-coding
// this here means the code is correct even if Dockerfile/env is misconfigured.
const TOURNAMENT_TZ = 'Europe/Sofia';
const _todayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TOURNAMENT_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit'
});
function todayLocalISO() {
  // en-CA happens to format as YYYY-MM-DD natively.
  return _todayFmt.format(new Date());
}

function clampInt(n, min, max) {
  if (typeof n !== 'number' || !isFinite(n)) return null;
  const v = Math.floor(n);
  if (v < min || v > max) return null;
  return v;
}

function validateLiveBody(body) {
  if (!body || typeof body !== 'object') return null;
  const sets = Array.isArray(body.sets) ? body.sets : [];
  const cur = Array.isArray(body.cur) ? body.cur : null;
  const tb  = body.tb && Array.isArray(body.tb) ? body.tb : null;
  if (!cur || cur.length !== 2) return null;
  if (sets.length > 5) return null;
  const cleanSets = [];
  for (const s of sets) {
    if (!Array.isArray(s) || s.length !== 2) return null;
    const a = clampInt(s[0], 0, 30);
    const b = clampInt(s[1], 0, 30);
    if (a === null || b === null) return null;
    cleanSets.push([a, b]);
  }
  const ca = clampInt(cur[0], 0, 30);
  const cb = clampInt(cur[1], 0, 30);
  if (ca === null || cb === null) return null;
  let cleanTb = null;
  if (tb && tb.length === 2) {
    const ta = clampInt(tb[0], 0, 50);
    const tb2 = clampInt(tb[1], 0, 50);
    if (ta === null || tb2 === null) return null;
    cleanTb = [ta, tb2];
  }
  return { sets: cleanSets, cur: [ca, cb], tb: cleanTb };
}

// Content-based ETag, cached. Recomputed only on writeData() or first GET.
let _dataETagCache = null;
function dataETag() {
  if (_dataETagCache) return _dataETagCache;
  try {
    const buf = fs.readFileSync(DATA_FILE);
    _dataETagCache = '"' + crypto.createHash('md5').update(buf).digest('hex').slice(0, 16) + '"';
    return _dataETagCache;
  } catch (e) { return '"empty"'; }
}

// Atomic write with rotating backups + fsync for durability.
//
// Sequence (designed so any crash leaves a recoverable state):
//   1. Write new content to tennis.json.tmp, fsync the file
//   2. Rotate backups: bak.2 → bak.3, bak.1 → bak.2 (renames only, atomic)
//   3. Hard-link current tennis.json → bak.1 (atomic on POSIX; falls back to
//      copy-after-rename on platforms where link() fails). This means bak.1
//      always points at a complete, fsync'd file — never a half-copied one.
//   4. Atomic rename: tmp → tennis.json
//   5. fsync the directory so the renames themselves reach disk
//
// Crash analysis:
//   - Crash during step 1: tmp may be partial; primary + backups untouched.
//   - Crash during step 2 or 3: primary untouched; one backup may shift but
//     the inode behind bak.1 is a complete prior file (link, not copy).
//   - Crash during step 4: rename is atomic at the FS layer; either old or
//     new primary is visible — never a half-written file.
//
// On corruption you can manually recover from .bak.1/.bak.2/.bak.3.
function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);

  // Step 1 — write tmp + fsync the file
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Steps 2–3 — rotate backups. Use rename (not copy) for steps 2; use
  // link (not copy) for step 3 so bak.1 always references a complete inode.
  // All best-effort: missing files are fine; fall back to copy if link fails
  // (e.g. cross-device, exotic FS).
  try { if (fs.existsSync(DATA_FILE + '.bak.2')) fs.renameSync(DATA_FILE + '.bak.2', DATA_FILE + '.bak.3'); } catch (e) {}
  try { if (fs.existsSync(DATA_FILE + '.bak.1')) fs.renameSync(DATA_FILE + '.bak.1', DATA_FILE + '.bak.2'); } catch (e) {}
  if (fs.existsSync(DATA_FILE)) {
    try {
      fs.linkSync(DATA_FILE, DATA_FILE + '.bak.1');
    } catch (e) {
      // EEXIST shouldn't happen (we just rotated), but if it does or link is
      // unsupported, fall back to copy. Copy of a complete file is safer than
      // copy of a primary mid-write, which is what the old code did.
      try { fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak.1'); } catch (e2) {}
    }
  }

  // Step 4 — atomic rename
  fs.renameSync(tmp, DATA_FILE);

  // Step 5 — fsync the directory so the rename hits disk. Best-effort: not
  // supported on Windows (EPERM on dir fsync), but production runs on Linux
  // (Coolify/Docker), so this matters there.
  try {
    const dirFd = fs.openSync(DATA_DIR, 'r');
    try { fs.fsyncSync(dirFd); }
    finally { fs.closeSync(dirFd); }
  } catch (e) { /* windows / non-critical */ }

  _dataETagCache = '"' + crypto.createHash('md5').update(json).digest('hex').slice(0, 16) + '"';
}

// Collect chunks as Buffer and decode once at the end. Concatenating chunks
// into a string with `body += c` decodes each chunk independently — a
// multi-byte UTF-8 character (e.g. Cyrillic, 2 bytes) split across a TCP
// boundary becomes U+FFFD garbage. Player names are Cyrillic, so this is
// not theoretical.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    let aborted = false;
    req.on('data', c => {
      if (aborted) return;
      len += c.length;
      if (len > 1024 * 512) {
        aborted = true;
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', reject);
  });
}

// Baseline security headers applied to every response. Cheap defense in depth:
//   - X-Content-Type-Options: don't let browsers MIME-sniff html out of json
//   - X-Frame-Options: forbid embedding in iframes (anti-clickjacking)
//   - Referrer-Policy: don't leak full URLs to third parties
//   - Permissions-Policy: deny features we never use
// CSP is intentionally NOT set here: Alpine needs 'unsafe-eval' + 'unsafe-inline'
// and that requires careful per-route handling. Add CSP when we have a clear
// inventory of inline-event-handlers we want to allow.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()'
};
function applySecurityHeaders(res) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
}

function json(res, status, payload) {
  applySecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// Constant-time string compare. `===` short-circuits on the first differing
// byte, leaking byte position via timing. timingSafeEqual requires equal-length
// buffers — we encode both as UTF-8 (so multibyte chars are compared byte-wise
// faithfully) and pad the shorter one to the longer's byte length. We always
// run the timingSafeEqual call to keep timing constant; the final length-equal
// check returns the real answer.
function safeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  const len = Math.max(ab.length, bb.length, 1);
  const padA = Buffer.alloc(len, 0); ab.copy(padA);
  const padB = Buffer.alloc(len, 0); bb.copy(padB);
  const eq = crypto.timingSafeEqual(padA, padB);
  // Returning false on different byte lengths is fine: knowing the length
  // doesn't help an attacker who must still guess every byte.
  return eq && ab.length === bb.length;
}

// In-memory session store: token → { expiresAt, ip }. Token is a 32-byte
// crypto-random hex string. TTL is 7 days; sessions don't survive restart
// (acceptable — admin re-enters password). Memory bound: even with hundreds
// of historical sessions it's a few KB; lazy GC on each lookup.
const _sessions = new Map();
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  _sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, ip });
  return token;
}

function checkSessionToken(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length !== 64) return false;
  const s = _sessions.get(token);
  if (!s) return false;
  if (now > s.expiresAt) {
    _sessions.delete(token);
    return false;
  }
  return true;
}

function revokeSession(token) {
  if (typeof token === 'string') _sessions.delete(token);
}

function checkAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  // Prefer session token (replaces plaintext password on the wire after login).
  const token = req.headers['x-admin-token'];
  if (token && checkSessionToken(token)) return true;
  // Backward-compat: still accept plaintext password header during the
  // transition. Will be removed in a future release.
  const provided = req.headers['x-admin-password'];
  return safeStringEqual(provided, ADMIN_PASSWORD);
}

// In-memory rate limiter for /api/auth. 5 failed attempts per IP in a 60-s
// window → 60-s lockout. Successful auth resets the counter for that IP.
// Memory bound: even under heavy attack, IPs rotate; entries older than 5 min
// are pruned lazily on each call. ~50 bytes per IP × thousands of IPs = fine.
const _authAttempts = new Map(); // ip → { count, firstAt, lockedUntil }
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_TRIES = 5;
const AUTH_LOCKOUT_MS = 60 * 1000;

// Append-only audit log of admin mutations. One JSON line per event in
// `<DATA_DIR>/audit.jsonl`. Lines are kept under ~1 KB so appends are atomic
// on POSIX (PIPE_BUF = 4096). Write errors are logged, not thrown — the
// underlying mutation already succeeded; failing audit must not roll it back.
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
function audit(req, action, details) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      ip: getClientIp(req),
      action,
      ...details
    };
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    log.error('audit write failed', { err: e.message, action });
  }
}

function getClientIp(req) {
  // Behind Coolify reverse proxy: trust X-Forwarded-For (first hop). Fall back
  // to socket address for direct connections (local dev).
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function authRateCheck(ip, now = Date.now()) {
  // Lazy GC: drop entries whose window has fully elapsed and are not locked.
  for (const [k, v] of _authAttempts) {
    if (now > (v.lockedUntil || 0) && now - v.firstAt > 5 * 60 * 1000) {
      _authAttempts.delete(k);
    }
  }
  const e = _authAttempts.get(ip);
  if (!e) return { ok: true };
  if (e.lockedUntil && now < e.lockedUntil) {
    return { ok: false, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) };
  }
  return { ok: true };
}

function authRateRecord(ip, success, now = Date.now()) {
  if (success) { _authAttempts.delete(ip); return; }
  let e = _authAttempts.get(ip);
  if (!e || (now - e.firstAt) > AUTH_WINDOW_MS) {
    e = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  e.count++;
  if (e.count >= AUTH_MAX_TRIES) e.lockedUntil = now + AUTH_LOCKOUT_MS;
  _authAttempts.set(ip, e);
}

function acceptsGzip(req) {
  const ae = req.headers['accept-encoding'] || '';
  return /\bgzip\b/.test(ae);
}

function acceptsBrotli(req) {
  const ae = req.headers['accept-encoding'] || '';
  return /\bbr\b/.test(ae);
}

function serveStatic(req, res, urlPath) {
  applySecurityHeaders(res);
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  const cached = fileCache.get(filePath) || loadIntoCache(filePath);
  if (!cached) {
    res.writeHead(404); return res.end('not found');
  }

  // sw.js MUST never be served from any intermediate cache (CDN/proxy/browser
  // HTTP cache). The browser bypasses HTTP cache for SW script fetches per
  // the spec, but `no-store` keeps shared caches honest too — without it a
  // CDN with stale rules could pin clients to an old SW indefinitely. Skip
  // the 304 short-circuit since responses are tiny and we want guaranteed
  // freshness on every request.
  const isServiceWorker = path.basename(filePath) === 'sw.js';

  // Conditional GET — instant 304 (skipped for sw.js)
  if (!isServiceWorker && req.headers['if-none-match'] === cached.etag) {
    res.writeHead(304, { 'ETag': cached.etag });
    return res.end();
  }

  // We have no build step → asset URLs don't carry content hashes. If we set
  // `immutable`, browsers won't revalidate for the full max-age window even
  // after a deploy. So shell text assets get must-revalidate (cheap via ETag
  // 304s); only images/fonts keep the long immutable cache.
  const longCache = cached.ext === '.png' || cached.ext === '.jpg' ||
                    cached.ext === '.ico' || cached.ext === '.woff' ||
                    cached.ext === '.woff2';
  const headers = {
    'Content-Type': MIME[cached.ext] || 'application/octet-stream',
    'ETag': cached.etag,
    'Cache-Control': isServiceWorker
      ? 'no-store, no-cache, must-revalidate'
      : (longCache ? 'public, max-age=604800, immutable'
                   : 'public, max-age=0, must-revalidate')
  };

  // Prefer Brotli over Gzip if both supported.
  if (cached.brotli && acceptsBrotli(req)) {
    headers['Content-Encoding'] = 'br';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = cached.brotli.length;
    res.writeHead(200, headers);
    return res.end(cached.brotli);
  }
  if (cached.gzipped && acceptsGzip(req)) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = cached.gzipped.length;
    res.writeHead(200, headers);
    return res.end(cached.gzipped);
  }
  headers['Content-Length'] = cached.content.length;
  res.writeHead(200, headers);
  res.end(cached.content);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    // ===== API =====
    if (url === '/api/data' && req.method === 'GET') {
      applySecurityHeaders(res);
      const etag = dataETag();
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'ETag': etag,
        'Cache-Control': 'no-cache'
      });
      return res.end(JSON.stringify(readData()));
    }

    if (url === '/api/data' && req.method === 'PUT') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      const incoming = JSON.parse(body);
      if (typeof incoming !== 'object' || !incoming.results || !incoming.schedule) {
        return json(res, 400, { error: 'invalid payload' });
      }
      // Reject unknown keys — only canonical pairs derivable from the current
      // player list are allowed. Defense in depth: even an authenticated client
      // shouldn't be able to write junk pairs (typo, swapped order) into state.
      // The player list itself is authoritative here — we don't trust the
      // client to add players via a /api/data PUT (use POST /api/players).
      const existing = readData();
      const validKeys = buildValidKeys(existing.players);
      for (const k in incoming.results) {
        if (!validKeys.has(k)) return json(res, 400, { error: 'invalid result key: ' + k });
        const r = incoming.results[k];
        if (!Array.isArray(r) || r.length !== 2) return json(res, 400, { error: 'invalid result value for ' + k });
        const a = clampInt(r[0], 0, 2);
        const b = clampInt(r[1], 0, 2);
        if (a === null || b === null) return json(res, 400, { error: 'invalid result value for ' + k });
        if (Math.max(a, b) !== 2 || Math.min(a, b) > 1) return json(res, 400, { error: 'invalid result value for ' + k });
      }
      for (const k in incoming.schedule) {
        if (!validKeys.has(k)) return json(res, 400, { error: 'invalid schedule key: ' + k });
        if (typeof incoming.schedule[k] !== 'string' || !incoming.schedule[k]) {
          return json(res, 400, { error: 'invalid schedule value for ' + k });
        }
      }
      const liveIn = incoming.live || {};
      const sanitizedLive = {};
      for (const k in liveIn) {
        if (!validKeys.has(k)) return json(res, 400, { error: 'invalid live key: ' + k });
        const v = validateLiveBody(liveIn[k]);
        if (!v) return json(res, 400, { error: 'invalid live state for ' + k });
        // Preserve updatedAt if client supplied it; otherwise stamp now.
        const updatedAt = typeof liveIn[k].updatedAt === 'string' ? liveIn[k].updatedAt : new Date().toISOString();
        sanitizedLive[k] = { ...v, updatedAt };
      }
      const recordedIn = incoming.resultsRecordedAt || {};
      for (const k in recordedIn) {
        if (!validKeys.has(k)) return json(res, 400, { error: 'invalid resultsRecordedAt key: ' + k });
        if (typeof recordedIn[k] !== 'string' || !recordedIn[k]) {
          return json(res, 400, { error: 'invalid resultsRecordedAt value for ' + k });
        }
      }
      writeData({
        results: incoming.results,
        schedule: incoming.schedule,
        live: sanitizedLive,
        resultsRecordedAt: recordedIn,
        players: existing.players,
        pushSubscriptions: existing.pushSubscriptions
      });
      audit(req, 'data.put', {
        resultsCount: Object.keys(incoming.results).length,
        scheduleCount: Object.keys(incoming.schedule).length,
        liveCount: Object.keys(sanitizedLive).length
      });
      return json(res, 200, { ok: true });
    }

    // POST /api/players  → append a new player. Admin-only.
    // Body: { name: "..." }. Name is trimmed, must be non-empty and unique.
    if (url === '/api/players' && req.method === 'POST') {
      if (!checkAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      if (!name) return json(res, 400, { error: 'name required' });
      if (name.length > 40) return json(res, 400, { error: 'name too long' });
      // Match keys use "|" as separator — disallow it in player names.
      if (name.includes('|')) return json(res, 400, { error: 'name cannot contain "|"' });
      const data = readData();
      if (data.players.includes(name)) return json(res, 409, { error: 'player exists' });
      data.players = [...data.players, name];
      writeData(data);
      audit(req, 'player.add', { name });
      return json(res, 200, { ok: true, players: data.players });
    }
    if (url === '/api/players') {
      res.writeHead(405, { 'Allow': 'POST' });
      return res.end();
    }

    // PATCH /api/players/<oldName>  → rename a player. Admin-only.
    // Body: { name: "newName" }. Migrates all match keys in results, schedule,
    // live, resultsRecordedAt atomically (one writeData), then updates the
    // players array. Re-keying preserves the player's index in the list, so
    // canonical pair ordering "P1|P2" stays consistent.
    // DELETE /api/players/<name>   → remove a player + all their matches.
    const playerMatch = url.match(/^\/api\/players\/(.+)$/);
    if (playerMatch) {
      if (!checkAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      const oldName = decodeURIComponent(playerMatch[1]);

      if (req.method === 'PATCH') {
        const body = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { return json(res, 400, { error: 'invalid json' }); }
        const newName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
        if (!newName) return json(res, 400, { error: 'name required' });
        if (newName.length > 40) return json(res, 400, { error: 'name too long' });
        if (newName.includes('|')) return json(res, 400, { error: 'name cannot contain "|"' });

        // ---- atomic critical section ----
        const data = readData();
        const idx = data.players.indexOf(oldName);
        if (idx === -1) return json(res, 404, { error: 'no such player' });
        if (newName === oldName) return json(res, 200, { ok: true, players: data.players });
        if (data.players.includes(newName)) return json(res, 409, { error: 'name already taken' });

        const migrated = migratePlayerRename(data, oldName, newName);
        writeData(migrated);
        audit(req, 'player.rename', { from: oldName, to: newName });
        return json(res, 200, { ok: true, players: migrated.players });
      }

      if (req.method === 'DELETE') {
        // ---- atomic critical section ----
        const data = readData();
        const idx = data.players.indexOf(oldName);
        if (idx === -1) return json(res, 404, { error: 'no such player' });
        if (data.players.length <= 2) return json(res, 400, { error: 'cannot delete — at least 2 players required' });
        const migrated = migratePlayerDelete(data, oldName);
        writeData(migrated);
        audit(req, 'player.delete', { name: oldName });
        return json(res, 200, { ok: true, players: migrated.players });
      }

      res.writeHead(405, { 'Allow': 'PATCH, DELETE' });
      return res.end();
    }
    if (url === '/api/data') {
      // Known path, unsupported method
      res.writeHead(405, { 'Allow': 'GET, PUT' });
      return res.end();
    }

    // ===== LIVE SCORING =====
    // POST /api/match/<key>/live  → update live state (open to non-admin on match day)
    // DELETE /api/match/<key>/live → clear live (admin only)
    const liveMatch = url.match(/^\/api\/match\/(.+)\/live$/);
    if (liveMatch) {
      const key = decodeURIComponent(liveMatch[1]);
      const isAdmin = checkAdmin(req);

      if (req.method === 'DELETE') {
        if (!isAdmin) return json(res, 401, { error: 'unauthorized' });
        // No body to await — readData → writeData runs synchronously, so no
        // other handler can interleave between the two and lose updates.
        const data = readData();
        if (!buildValidKeys(data.players).has(key)) return json(res, 404, { error: 'no such match' });
        if (data.live[key]) {
          delete data.live[key];
          writeData(data);
          audit(req, 'live.clear', { key });
        }
        return json(res, 200, { ok: true });
      }

      if (req.method !== 'POST') {
        res.writeHead(405); return res.end();
      }

      // Await body BEFORE readData. Node is single-threaded, so as long as
      // there are no awaits between readData and writeData, the critical
      // section is atomic — no other handler can read+write in between and
      // cause a lost-update race.
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const v = validateLiveBody(parsed);
      if (!v) return json(res, 400, { error: 'invalid live state' });

      // ---- atomic critical section (no awaits below) ----
      const data = readData();
      if (!buildValidKeys(data.players).has(key)) return json(res, 404, { error: 'no such match' });
      if (data.results[key]) return json(res, 409, { error: 'match already finished' });
      if (!isAdmin) {
        const sched = data.schedule[key];
        if (!sched) return json(res, 403, { error: 'match not scheduled' });
        if (sched.slice(0, 10) !== todayLocalISO()) {
          return json(res, 403, { error: 'not match day' });
        }
      }

      // Snapshot previous live state for event detection (push notifications).
      const prevLive = data.live[key] || null;
      const prevSetsCount = prevLive ? prevLive.sets.length : 0;

      // Auto-finalize if either player has won 2 sets
      let setsA = 0, setsB = 0;
      for (const [a, b] of v.sets) {
        if (a > b) setsA++;
        else if (b > a) setsB++;
      }
      // Fully-empty state means user undid everything back to zero — drop the
      // live entry so the match returns to "scheduled" until a real point
      // gets recorded again.
      const isEmpty = v.sets.length === 0 && v.cur[0] === 0 && v.cur[1] === 0 && !v.tb;
      let finalized = false;
      let cleared = false;
      if (setsA >= 2 || setsB >= 2) {
        data.results[key] = [setsA, setsB];
        data.resultsRecordedAt[key] = new Date().toISOString();
        delete data.live[key];
        if (data.schedule[key]) delete data.schedule[key];
        finalized = true;
      } else if (isEmpty) {
        if (data.live[key]) {
          delete data.live[key];
          cleared = true;
        }
      } else {
        data.live[key] = { ...v, updatedAt: new Date().toISOString() };
      }
      writeData(data);
      if (finalized) {
        audit(req, 'match.finalize', { key, score: data.results[key], via: 'live', isAdmin });
      } else if (cleared) {
        audit(req, 'live.cleared-empty', { key, isAdmin });
      } else {
        audit(req, 'live.update', { key, sets: v.sets.length, isAdmin });
      }

      // ---- push notifications (fire-and-forget, after the response is sent) ----
      // Match start: no previous live state and the new state has any non-zero
      // score (a point was scored). Treat undo-back-to-zero as not-a-start.
      const hasAnyScore = v.sets.length > 0 || v.cur[0] > 0 || v.cur[1] > 0 || !!v.tb;
      if (!finalized && !cleared && !prevLive && hasAnyScore) {
        sendPushToAll(matchPushPayload('match.start', key));
      }
      // Set complete: sets array length grew (excluding the auto-finalize case
      // which we report as match.finish below to avoid double-notifying).
      if (!finalized && v.sets.length > prevSetsCount) {
        const lastSet = v.sets[v.sets.length - 1];
        sendPushToAll(matchPushPayload('set.complete', key, {
          setNumber: v.sets.length,
          setScore: lastSet
        }));
      }
      // Match finish via auto-finalize.
      if (finalized) {
        sendPushToAll(matchPushPayload('match.finish', key, { result: data.results[key] }));
      }
      return json(res, 200, {
        ok: true,
        finalized,
        cleared,
        live: data.live[key] || null,
        result: finalized ? data.results[key] : null
      });
    }

    // POST /api/match/<key>/result  → record final result
    // Admin: always allowed. Non-admin: only on match day, must be scheduled.
    const resultMatch = url.match(/^\/api\/match\/(.+)\/result$/);
    if (resultMatch) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const key = decodeURIComponent(resultMatch[1]);
      const isAdmin = checkAdmin(req);

      // Body first → critical section atomic (no awaits between read/write).
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const s1 = clampInt(parsed && parsed.s1, 0, 2);
      const s2 = clampInt(parsed && parsed.s2, 0, 2);
      if (s1 === null || s2 === null) return json(res, 400, { error: 'invalid score' });
      const max = Math.max(s1, s2), min = Math.min(s1, s2);
      if (max !== 2 || min > 1) return json(res, 400, { error: 'invalid score' });

      // ---- atomic critical section ----
      const data = readData();
      if (!buildValidKeys(data.players).has(key)) return json(res, 404, { error: 'no such match' });
      if (!isAdmin) {
        const sched = data.schedule[key];
        if (!sched) return json(res, 403, { error: 'match not scheduled' });
        if (sched.slice(0, 10) !== todayLocalISO()) {
          return json(res, 403, { error: 'not match day' });
        }
      }
      data.results[key] = [s1, s2];
      data.resultsRecordedAt[key] = new Date().toISOString();
      if (data.schedule[key]) delete data.schedule[key];
      if (data.live[key]) delete data.live[key];
      writeData(data);
      audit(req, 'match.finalize', { key, score: [s1, s2], via: 'result', isAdmin });
      sendPushToAll(matchPushPayload('match.finish', key, { result: [s1, s2] }));
      return json(res, 200, { ok: true, result: [s1, s2] });
    }

    // ===== PUSH NOTIFICATIONS =====
    // GET /api/push/vapid-public-key  → returns the public key (or 404 if push disabled)
    // POST /api/push/subscribe        → body: PushSubscription JSON; idempotent by endpoint
    // POST /api/push/unsubscribe      → body: { endpoint: "..." }; idempotent
    if (url === '/api/push/vapid-public-key' && req.method === 'GET') {
      if (!pushEnabled) return json(res, 404, { error: 'push disabled' });
      return json(res, 200, { publicKey: process.env.VAPID_PUBLIC_KEY });
    }
    if (url === '/api/push/subscribe' && req.method === 'POST') {
      if (!pushEnabled) return json(res, 503, { error: 'push disabled' });
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      if (!parsed || typeof parsed.endpoint !== 'string' || !parsed.endpoint
          || !parsed.keys || typeof parsed.keys.p256dh !== 'string' || typeof parsed.keys.auth !== 'string') {
        return json(res, 400, { error: 'invalid subscription' });
      }
      // Reject endpoints longer than 1KB (sanity).
      if (parsed.endpoint.length > 1024) return json(res, 400, { error: 'endpoint too long' });
      // ---- atomic critical section ----
      const data = readData();
      const exists = data.pushSubscriptions.find(s => s.endpoint === parsed.endpoint);
      if (!exists) {
        data.pushSubscriptions = [...data.pushSubscriptions, {
          endpoint: parsed.endpoint,
          keys: { p256dh: parsed.keys.p256dh, auth: parsed.keys.auth },
          subscribedAt: new Date().toISOString()
        }];
        // Cap at 500 subscribers (way more than this league will ever see).
        if (data.pushSubscriptions.length > 500) {
          data.pushSubscriptions = data.pushSubscriptions.slice(-500);
        }
        writeData(data);
        log.info('push: new subscription', { endpoint: parsed.endpoint.slice(0, 60), total: data.pushSubscriptions.length });
      }
      return json(res, 200, { ok: true });
    }
    if (url === '/api/push/unsubscribe' && req.method === 'POST') {
      if (!pushEnabled) return json(res, 200, { ok: true });
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const endpoint = parsed && typeof parsed.endpoint === 'string' ? parsed.endpoint : '';
      if (!endpoint) return json(res, 400, { error: 'endpoint required' });
      const data = readData();
      const before = data.pushSubscriptions.length;
      data.pushSubscriptions = data.pushSubscriptions.filter(s => s.endpoint !== endpoint);
      if (data.pushSubscriptions.length !== before) {
        writeData(data);
        log.info('push: unsubscribed', { endpoint: endpoint.slice(0, 60), total: data.pushSubscriptions.length });
      }
      return json(res, 200, { ok: true });
    }

    if (url === '/api/auth' && req.method === 'POST') {
      const ip = getClientIp(req);
      const gate = authRateCheck(ip);
      if (!gate.ok) {
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        return json(res, 429, { error: 'too many attempts', retryAfterSec: gate.retryAfterSec });
      }
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const password = typeof parsed.password === 'string' ? parsed.password : '';
      const ok = !!ADMIN_PASSWORD && safeStringEqual(password, ADMIN_PASSWORD);
      authRateRecord(ip, ok);
      if (!ok) return json(res, 401, { ok: false });
      const token = createSession(ip);
      audit(req, 'session.create', {});
      return json(res, 200, { ok: true, token, expiresInSec: SESSION_TTL_MS / 1000 });
    }

    // Logout: revoke a specific session token. Idempotent.
    if (url === '/api/auth' && req.method === 'DELETE') {
      const token = req.headers['x-admin-token'];
      if (typeof token === 'string') {
        revokeSession(token);
        audit(req, 'session.revoke', {});
      }
      return json(res, 200, { ok: true });
    }

    if (url === '/api/health') {
      return json(res, 200, { ok: true, hasAdmin: !!ADMIN_PASSWORD });
    }

    // /api/version — canonical "what's currently deployed?" endpoint. The
    // client polls this to detect updates without parsing sw.js text. Cheap
    // (returns ~80 bytes); never cached so the response is always fresh.
    if (url === '/api/version') {
      applySecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate'
      });
      return res.end(JSON.stringify({ version: CACHE_VERSION }));
    }

    // Unknown /api/* path — return 404 JSON instead of falling through to static
    if (url.startsWith('/api/')) {
      return json(res, 404, { error: 'not found' });
    }

    // ===== STATIC =====
    serveStatic(req, res, url);
  } catch (e) {
    log.error('handler error', { err: e.message, stack: e.stack, url: req.url, method: req.method });
    if (e.code === 'EBADJSON') {
      // Data file is corrupt. Refusing to write would lose all current state;
      // return 503 so the client knows to retry or operator can recover from
      // .bak.1/.bak.2/.bak.3 manually.
      return json(res, 503, { error: 'data file corrupt — recover from backup' });
    }
    json(res, 500, { error: e.message });
  }
});

// Only listen when invoked directly (e.g. `node server.js`). When required
// from a test file, callers get the helpers without a port being bound.
if (require.main === module) {
  server.listen(PORT, () => {
    log.info('server ready', { port: PORT, dataFile: DATA_FILE, cacheVersion: CACHE_VERSION });
  });

  // Graceful shutdown: on SIGTERM (Coolify rolling deploy) or SIGINT (Ctrl+C),
  // stop accepting new connections, let in-flight requests finish, then exit.
  // Without this, an in-flight `await readBody` during deploy is dropped and
  // the user sees a connection error. writeData itself is sync + fsync'd so
  // it can't be interrupted partway.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown: signal received', { signal });
    // Force-exit after 10 s so a stuck connection can't block deploy forever.
    const killTimer = setTimeout(() => {
      log.warn('shutdown: drain timeout — exiting forcefully');
      process.exit(1);
    }, 10000);
    killTimer.unref();
    server.close(err => {
      if (err) {
        log.error('shutdown: server.close error', { err: err.message });
        process.exit(1);
      }
      log.info('shutdown: clean exit');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
  // Pure helpers
  buildValidKeys,
  clampInt,
  validateLiveBody,
  migratePlayerRename,
  migratePlayerDelete,
  safeStringEqual,
  todayLocalISO,
  authRateCheck,
  authRateRecord,
  createSession,
  checkSessionToken,
  revokeSession,
  // IO (use with a tmp DATA_DIR for tests)
  readData,
  writeData,
  // Wired-up server (for integration smoke tests)
  server
};
