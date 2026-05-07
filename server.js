const http = require('http');
const fs = require('fs');
const path = require('path');

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

function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch (e) { return { results: {}, schedule: {} }; }
}

function writeData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic on same fs
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

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];

    // ===== API =====
    if (url === '/api/data' && req.method === 'GET') {
      return json(res, 200, readData());
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
    let filePath = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : url);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404); return res.end('not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      res.end(content);
    });
  } catch (e) {
    console.error('[err]', e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[ready] Тенис Лига Велинград on :${PORT} (data: ${DATA_FILE})`);
});
