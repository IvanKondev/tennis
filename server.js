const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { PLAYERS } = require('./data.js');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'tennis.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set — admin writes are disabled.');
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
  console.log('[init] Created empty data file at', DATA_FILE);
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
    console.log(`[cache] Preloaded 0 static files`);
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
    const cacheVersion = 'tennis-' + h.digest('hex').slice(0, 12);
    const raw = fs.readFileSync(swPath, 'utf-8');
    const transformed = Buffer.from(raw.replace('__CACHE_VERSION__', cacheVersion), 'utf-8');
    loadIntoCache(swPath, transformed);
    console.log(`[cache] sw.js CACHE_VERSION=${cacheVersion}`);
  }
  console.log(`[cache] Preloaded ${fileCache.size} static files (HTML asset URLs versioned, sw.js auto-versioned)`);
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
  return d;
}

function todayLocalISO() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
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
// Sequence:
//   1. Rotate existing backups: bak.2 → bak.3, bak.1 → bak.2, current → bak.1
//   2. Write new content to tennis.json.tmp, fsync the file
//   3. Rename .tmp → tennis.json (atomic on POSIX; same dir on Windows)
//   4. fsync the directory so the rename itself reaches disk
// On corruption you can manually recover from .bak.1/.bak.2/.bak.3.
function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);

  // Step 1 — rotate backups (best-effort; missing files are fine).
  try { if (fs.existsSync(DATA_FILE + '.bak.2')) fs.renameSync(DATA_FILE + '.bak.2', DATA_FILE + '.bak.3'); } catch (e) {}
  try { if (fs.existsSync(DATA_FILE + '.bak.1')) fs.renameSync(DATA_FILE + '.bak.1', DATA_FILE + '.bak.2'); } catch (e) {}
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak.1'); } catch (e) {}

  // Step 2 — write tmp + fsync the file
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Step 3 — atomic rename
  fs.renameSync(tmp, DATA_FILE);

  // Step 4 — fsync the directory so the rename hits disk. Best-effort: not
  // supported on Windows (EPERM on dir fsync), but production runs on Linux
  // (Coolify/Docker), so this matters there.
  try {
    const dirFd = fs.openSync(DATA_DIR, 'r');
    try { fs.fsyncSync(dirFd); }
    finally { fs.closeSync(dirFd); }
  } catch (e) { /* windows / non-critical */ }

  _dataETagCache = '"' + crypto.createHash('md5').update(json).digest('hex').slice(0, 16) + '"';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1024 * 512) reject(new Error('payload too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function checkAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  return req.headers['x-admin-password'] === ADMIN_PASSWORD;
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
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  const cached = fileCache.get(filePath) || loadIntoCache(filePath);
  if (!cached) {
    res.writeHead(404); return res.end('not found');
  }

  // Conditional GET — instant 304
  if (req.headers['if-none-match'] === cached.etag) {
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
    'Cache-Control': longCache
      ? 'public, max-age=604800, immutable'
      : 'public, max-age=0, must-revalidate'
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
        players: existing.players
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
      return json(res, 200, { ok: true, result: [s1, s2] });
    }

    if (url === '/api/auth' && req.method === 'POST') {
      const body = await readBody(req);
      const { password } = JSON.parse(body || '{}');
      const ok = !!ADMIN_PASSWORD && password === ADMIN_PASSWORD;
      return json(res, ok ? 200 : 401, { ok });
    }

    if (url === '/api/health') {
      return json(res, 200, { ok: true, hasAdmin: !!ADMIN_PASSWORD });
    }

    // Unknown /api/* path — return 404 JSON instead of falling through to static
    if (url.startsWith('/api/')) {
      return json(res, 404, { error: 'not found' });
    }

    // ===== STATIC =====
    serveStatic(req, res, url);
  } catch (e) {
    console.error('[err]', e);
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
    console.log(`[ready] Тенис Лига Велинград on :${PORT} (data: ${DATA_FILE})`);
  });
}

module.exports = {
  // Pure helpers
  buildValidKeys,
  clampInt,
  validateLiveBody,
  migratePlayerRename,
  migratePlayerDelete,
  // IO (use with a tmp DATA_DIR for tests)
  readData,
  writeData,
  // Wired-up server (for integration smoke tests)
  server
};
