const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(DATA_DIR, 'tennis.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn('[WARN] ADMIN_PASSWORD not set — admin writes are disabled.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ results: {}, schedule: {} }, null, 2));
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
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch (e) { return { results: {}, schedule: {} }; }
}

function dataETag() {
  try {
    const s = fs.statSync(DATA_FILE);
    return '"' + s.mtimeMs.toString(36) + '-' + s.size.toString(36) + '"';
  } catch (e) { return '"empty"'; }
}

function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
      writeData({ results: incoming.results, schedule: incoming.schedule });
      return json(res, 200, { ok: true });
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
