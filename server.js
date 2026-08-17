/**
 * Core Pilates Studio — static host + booking/membership API.
 *
 * Node 18+, zero npm dependencies. Everything under public/ is served as-is;
 * anything under /api/ is handled by lib/api.js.
 *
 *   node server.js          → http://localhost:3000
 *   PORT=8080 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

// Minimal .env reader — keeps the "no dependencies to install" promise.
(function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
})();

const api = require('./lib/api');
const payments = require('./lib/payments');
const store = require('./lib/store');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, json, headers = {}) {
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  // Resolve inside public/ only — no traversal out of the web root.
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  let file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return notFound(res);

  if (!fs.existsSync(file) && !path.extname(file)) file += '.html'; // /book → /book.html
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return notFound(res);

  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // Markup, styles and scripts revalidate against the ETag on every request:
    // still a 304 when nothing changed, but an edit is never served stale.
    // Images are content-addressed by filename, so they can cache hard.
    'Cache-Control': ['.html', '.css', '.js'].includes(ext)
      ? 'no-cache'
      : 'public, max-age=86400',
  });
  fs.createReadStream(file).pipe(res);
}

function notFound(res) {
  const page = path.join(PUBLIC, '404.html');
  if (fs.existsSync(page)) {
    const body = fs.readFileSync(page);
    res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': body.length });
    return res.end(body);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost:' + PORT}`);

  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed.' });
    }
    return serveStatic(req, res, url.pathname);
  }

  try {
    const raw = req.method === 'GET' ? '' : await readBody(req);
    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        // Webhooks post raw JSON we hand straight to the verifier; other
        // malformed bodies are a client bug worth reporting clearly.
        if (!url.pathname.startsWith('/api/webhooks/')) {
          return sendJson(res, 400, { error: 'Malformed JSON body.' });
        }
      }
    }

    const result = await api.handle({
      req,
      res,
      raw,
      body,
      method: req.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      origin: url.origin,
    });

    if (!result) return sendJson(res, 404, { error: 'No such endpoint.' });
    sendJson(res, result.status, result.json, result.headers);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[api]', err);
    sendJson(res, status, { error: err.message || 'Something went wrong.' });
  }
});

server.listen(PORT, () => {
  store.read(); // build data/db.json on first boot
  console.log(`\n  Core Pilates Studio  →  http://localhost:${PORT}`);
  console.log(
    `  Payments: ${payments.live() ? 'Stripe (live keys detected)' : 'demo mode — no card is charged'}`
  );
  console.log(`  Data:     ${path.relative(ROOT, store.DB_FILE)}\n`);
});
