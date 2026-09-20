'use strict';
// Local development server: serves the static files and mounts
// /api/verify-submission exactly like Vercel does. No Vercel CLI, no login.
//   npm run dev   ->  http://localhost:3000
// Secrets are read from .env.local (never served to the browser).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;

// load .env.local / .env (Node >= 20.12)
for (const f of ['.env.local', '.env']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) { try { process.loadEnvFile(p); console.log(`Loaded ${f}`); } catch (e) { console.warn(`Could not read ${f}: ${e.message}`); } }
}

const handler = require('./api/verify-submission');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// only these top-level files are public — never serve .env*, lib/, api/, node_modules, tests, or the csv
const PUBLIC = new Set(['index.html', 'styles.css', 'script.js', 'config.js']);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/verify-submission') {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 6 * 1024 * 1024) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { req.body = null; }
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (b) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); };
      await handler(req, res);
    });
    return;
  }

  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!PUBLIC.has(name)) { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const missing = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter(k => !process.env[k]);
  console.log(`\nOpen http://localhost:${PORT}`);
  if (missing.length) console.log(`\n!! Missing in .env.local: ${missing.join(', ')} — submissions will fail until you add them.`);
});
