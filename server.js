/**
 * Tiny static-file + drawings-API server. Zero dependencies (Node stdlib).
 *
 * Run:  node server.js   →  http://localhost:8123
 *
 * Serves the app and persists drawings as JSON files in ./drawings/.
 * The frontend probes GET /api/drawings on startup: if it answers, the app
 * saves here (real folder); if not (e.g. opened as a plain file), it falls
 * back to browser localStorage.
 *
 * API:
 *   GET    /api/drawings          → [{ name, savedAt, thumbnail }]
 *   GET    /api/drawings/<name>   → full drawing JSON
 *   PUT    /api/drawings/<name>   → save (body = drawing JSON)
 *   DELETE /api/drawings/<name>   → delete
 *   GET    /api/eraser?url=<link> → { title, dataUrl } — proxy that pulls the
 *          public preview image of an app.eraser.io share link (the browser
 *          can't fetch it directly because of CORS). Needs Node 18+ (fetch).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DRAWINGS_DIR = path.join(ROOT, 'drawings');
const PORT = process.env.PORT || 8123;
const MAX_BODY = 30 * 1024 * 1024; // embedded icon fonts can be large

fs.mkdirSync(DRAWINGS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.md': 'text/plain',
};

// Allow only safe filenames — this is what keeps the API from being a
// path-traversal hole (e.g. name = "../../etc/passwd").
function safeName(raw) {
  const name = decodeURIComponent(raw).trim();
  return /^[\w][\w \-]{0,60}$/.test(name) ? name : null;
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ------------------------------------------------------ drawings API
  if (url.pathname === '/api/drawings' && req.method === 'GET') {
    const items = fs.readdirSync(DRAWINGS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        // read each file for its metadata; fine at gallery scale
        try {
          const data = JSON.parse(fs.readFileSync(path.join(DRAWINGS_DIR, f), 'utf8'));
          return { name: f.slice(0, -5), savedAt: data.savedAt || null, thumbnail: data.thumbnail || null };
        } catch {
          return { name: f.slice(0, -5), savedAt: null, thumbnail: null };
        }
      })
      .sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
    return send(res, 200, JSON.stringify(items));
  }

  // ------------------------------------------------------- icon library
  // Enumerates ./icons/<category>/<name>.svg for the "place icon" panel;
  // the SVG files themselves are served by the static handler below.
  if (url.pathname === '/api/icons' && req.method === 'GET') {
    const dir = path.join(ROOT, 'icons');
    const out = {};
    if (fs.existsSync(dir)) {
      for (const cat of fs.readdirSync(dir).sort()) {
        const d = path.join(dir, cat);
        if (!fs.statSync(d).isDirectory()) continue;
        const files = fs.readdirSync(d).filter(f => f.endsWith('.svg')).sort();
        if (files.length) out[cat] = files;
      }
    }
    return send(res, 200, JSON.stringify(out));
  }

  // --------------------------------------------------- eraser.io import
  // Accepts a share link, extracts the workspace id, and fetches only from
  // the fixed app.eraser.io host — the client never controls the target
  // URL, so this can't be abused as an open proxy.
  if (url.pathname === '/api/eraser' && req.method === 'GET') {
    const share = url.searchParams.get('url') || '';
    const m = share.match(/^https:\/\/app\.eraser\.io\/workspace\/([A-Za-z0-9_-]+)/);
    if (!m) return send(res, 400, '{"error":"not an app.eraser.io workspace link"}');
    const id = m[1];
    const headers = { 'User-Agent': 'Mozilla/5.0 (vSketch importer)' };

    (async () => {
      const page = await fetch(`https://app.eraser.io/workspace/${id}`, { headers });
      if (!page.ok) throw new Error(`eraser answered ${page.status} for the share page`);
      const html = await page.text();
      const title = ((html.match(/property="og:title" content="([^"]*)"/) || [])[1] || '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      // unknown/private workspaces get eraser's generic marketing page
      if (/AI co-pilot for technical design/i.test(title)) {
        throw new Error('workspace not found — is the link correct and shared publicly?');
      }

      const img = await fetch(`https://app.eraser.io/workspace/${id}/preview`, { headers });
      if (!img.ok) throw new Error(`eraser answered ${img.status} for the preview image`);
      const type = img.headers.get('content-type') || 'image/jpeg';
      if (!type.startsWith('image/')) throw new Error('preview is not an image — link may be private');
      const buf = Buffer.from(await img.arrayBuffer());
      send(res, 200, JSON.stringify({ title, dataUrl: `data:${type};base64,${buf.toString('base64')}` }));
    })().catch(err => send(res, 502, JSON.stringify({ error: err.message })));
    return;
  }

  const match = url.pathname.match(/^\/api\/drawings\/(.+)$/);
  if (match) {
    const name = safeName(match[1]);
    if (!name) return send(res, 400, '{"error":"invalid name"}');
    const file = path.join(DRAWINGS_DIR, name + '.json');

    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return send(res, 404, '{"error":"not found"}');
      return send(res, 200, fs.readFileSync(file));
    }

    if (req.method === 'PUT') {
      let body = '', size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY) { send(res, 413, '{"error":"too large"}'); req.destroy(); }
        else body += chunk;
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        try { JSON.parse(body); } catch { return send(res, 400, '{"error":"invalid JSON"}'); }
        fs.writeFileSync(file, body);
        send(res, 200, '{"ok":true}');
      });
      return;
    }

    if (req.method === 'DELETE') {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return send(res, 200, '{"ok":true}');
    }

    return send(res, 405, '{"error":"method not allowed"}');
  }

  // ------------------------------------------------------ static files
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, () => {
  console.log(`vSketch running at http://localhost:${PORT}`);
  console.log(`Drawings are saved to ${DRAWINGS_DIR}`);
});
