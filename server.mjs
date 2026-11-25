import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5173;
const STATE_FILE = path.join(__dirname, '.live_state.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const clients = new Set(); // active SSE responses
const pendingExecs = new Map(); // reqId -> { resolve, reject, timer }
let latestState = null;

if (fs.existsSync(STATE_FILE)) {
  try {
    latestState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function broadcastSSE(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch {
      clients.delete(res);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS headers for flexibility
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- SSE Event Stream for Live Browser Sync ----
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ clients: clients.size + 1 })}\n\n`);
    clients.add(res);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
    return;
  }

  // ---- Health & Connection Status ----
  if (pathname === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      connectedBrowsers: clients.size,
      hasSavedState: Boolean(latestState),
      metrics: latestState?.metrics || null,
      projectName: latestState?.projectName || null,
    }));
    return;
  }

  // ---- Browser pushes latest state snapshot ----
  if (pathname === '/api/state' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      latestState = {
        updatedAt: new Date().toISOString(),
        projectName: body.projectName,
        metrics: body.metrics,
        camera: body.camera,
        state: body.state,
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(latestState), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ---- Read latest state & architectural summary ----
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(latestState || { state: null }));
    return;
  }

  // ---- Agent executes live build/edit code inside connected browser ----
  if (pathname === '/api/exec' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const { code, description = 'Agent Build' } = JSON.parse(raw);
      if (clients.size === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'No browser viewport is currently connected to /api/events.',
        }));
        return;
      }
      const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const resultPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingExecs.delete(reqId);
          reject(new Error('Timed out waiting for browser execution result'));
        }, 12000);
        pendingExecs.set(reqId, { resolve, reject, timer });
      });

      broadcastSSE('exec', { reqId, code, description });
      const result = await resultPromise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ---- Browser posts execution result back ----
  if (pathname === '/api/exec-result' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const pending = pendingExecs.get(body.reqId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingExecs.delete(body.reqId);
        pending.resolve(body);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // ---- Static File Serving ----
  let relPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(__dirname, safePath);

  if (!fullPath.startsWith(__dirname) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(fullPath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ArchSketch Studio Live Bridge listening on http://0.0.0.0:${PORT}`);
});
