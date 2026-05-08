const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { MATCHES_SEED } = require('./data.js');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'tennis.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set — admin writes are disabled.');
}

// Set of valid canonical match keys (one direction only — same as MATCHES_SEED)
const VALID_KEYS = new Set(MATCHES_SEED.map(([a, b]) => a + '|' + b));

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ results: {}, schedule: {}, live: {} }, null, 2));
  console.log('[init] Created empty data file at', DATA_FILE);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2'
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.json']);

// ===== File cache (loaded into memory at startup) =====
const fileCache = new Map();

function loadIntoCache(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const etag = '"' + crypto.createHash('md5').update(content).digest('hex').slice(0, 16) + '"';
    const ext = path.extname(filePath).toLowerCase();
    const entry = { content, etag, ext };
    if (COMPRESSIBLE.has(ext) && content.length > 1024) {
      entry.gzipped = zlib.gzipSync(content, { level: 9 });
    }
    fileCache.set(filePath, entry);
    return entry;
  } catch (e) { return null; }
}

function preloadPublicDir() {
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else loadIntoCache(full);
    }
  };
  if (fs.existsSync(PUBLIC_DIR)) walk(PUBLIC_DIR);
  console.log(`[cache] Preloaded ${fileCache.size} static files`);
}

preloadPublicDir();

function readData() {
  let d;
  try { d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch (e) { d = {}; }
  if (!d.results) d.results = {};
  if (!d.schedule) d.schedule = {};
  if (!d.live) d.live = {};
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

function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DATA_FILE);
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

  const isHtml = cached.ext === '.html';
  const headers = {
    'Content-Type': MIME[cached.ext] || 'application/octet-stream',
    'ETag': cached.etag,
    'Cache-Control': isHtml
      ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=604800, immutable'
  };

  // Gzip if available + accepted
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
      writeData({
        results: incoming.results,
        schedule: incoming.schedule,
        live: incoming.live || {}
      });
      return json(res, 200, { ok: true });
    }

    // ===== LIVE SCORING =====
    // POST /api/match/<key>/live  → update live state (open to non-admin on match day)
    // DELETE /api/match/<key>/live → clear live (admin only)
    const liveMatch = url.match(/^\/api\/match\/(.+)\/live$/);
    if (liveMatch) {
      const key = decodeURIComponent(liveMatch[1]);
      if (!VALID_KEYS.has(key)) return json(res, 404, { error: 'no such match' });

      const data = readData();

      if (req.method === 'DELETE') {
        if (!checkAdmin(req)) return json(res, 401, { error: 'unauthorized' });
        if (data.live[key]) {
          delete data.live[key];
          writeData(data);
        }
        return json(res, 200, { ok: true });
      }

      if (req.method !== 'POST') {
        res.writeHead(405); return res.end();
      }

      const isAdmin = checkAdmin(req);
      if (data.results[key]) return json(res, 409, { error: 'match already finished' });

      if (!isAdmin) {
        const sched = data.schedule[key];
        if (!sched) return json(res, 403, { error: 'match not scheduled' });
        if (sched.slice(0, 10) !== todayLocalISO()) {
          return json(res, 403, { error: 'not match day' });
        }
      }

      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const v = validateLiveBody(parsed);
      if (!v) return json(res, 400, { error: 'invalid live state' });

      // Auto-finalize if either player has won 2 sets
      let setsA = 0, setsB = 0;
      for (const [a, b] of v.sets) {
        if (a > b) setsA++;
        else if (b > a) setsB++;
      }
      let finalized = false;
      if (setsA >= 2 || setsB >= 2) {
        data.results[key] = [setsA, setsB];
        delete data.live[key];
        if (data.schedule[key]) delete data.schedule[key];
        finalized = true;
      } else {
        data.live[key] = { ...v, updatedAt: new Date().toISOString() };
      }
      writeData(data);
      return json(res, 200, {
        ok: true,
        finalized,
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
      if (!VALID_KEYS.has(key)) return json(res, 404, { error: 'no such match' });

      const data = readData();
      const isAdmin = checkAdmin(req);

      if (!isAdmin) {
        const sched = data.schedule[key];
        if (!sched) return json(res, 403, { error: 'match not scheduled' });
        if (sched.slice(0, 10) !== todayLocalISO()) {
          return json(res, 403, { error: 'not match day' });
        }
      }

      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) { return json(res, 400, { error: 'invalid json' }); }
      const s1 = clampInt(parsed && parsed.s1, 0, 2);
      const s2 = clampInt(parsed && parsed.s2, 0, 2);
      if (s1 === null || s2 === null) return json(res, 400, { error: 'invalid score' });
      // Best-of-3: winner reaches 2, loser ≤ 1
      const max = Math.max(s1, s2), min = Math.min(s1, s2);
      if (max !== 2 || min > 1) return json(res, 400, { error: 'invalid score' });

      data.results[key] = [s1, s2];
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

    // ===== STATIC =====
    serveStatic(req, res, url);
  } catch (e) {
    console.error('[err]', e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[ready] Тенис Лига Велинград on :${PORT} (data: ${DATA_FILE})`);
});
