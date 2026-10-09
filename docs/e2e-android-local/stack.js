'use strict';
// LOCAL STAGING STACK (scratch only): /rest/v1 proxy → PostgREST, a fake R2 (stores bytes; PUT/HEAD/GET),
// and the REAL okb-bridge-cloud-backend (branch code, real Supabase store) on :8095.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const BACKEND = path.resolve(process.env.OKB_BACKEND_DIR || path.join(__dirname, '../../../okb-bridge-cloud-backend'));
const dir = process.env.E2E_STACK_DIR || __dirname;
process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = fs.readFileSync(path.join(dir, 'service.jwt'), 'utf8');

// 1. Supabase-style path prefix in front of PostgREST.
http.createServer((req, res) => {
  const target = req.url.replace(/^\/rest\/v1/, '');
  const p = http.request({ host: '127.0.0.1', port: 3001, path: target, method: req.method, headers: { ...req.headers, host: '127.0.0.1:3001' } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on('error', () => { res.writeHead(502); res.end(); });
  req.pipe(p);
}).listen(54321, '127.0.0.1');

// 2. Fake R2 (objects persisted under stack/r2 so tests can hash them).
const R2DIR = path.join(dir, 'r2'); fs.mkdirSync(R2DIR, { recursive: true });
let r2Down = false;
const file = (key) => path.join(R2DIR, encodeURIComponent(key));
const r2srv = http.createServer((req, res) => {
  if (r2Down) { res.writeHead(503); return res.end(); }
  const key = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  if (req.method === 'PUT') {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fs.writeFileSync(file(key), Buffer.concat(chunks)); res.writeHead(200, { ETag: '"local-etag"' }); res.end(); });
    return;
  }
  if (!fs.existsSync(file(key))) { res.writeHead(404); return res.end(); }
  const buf = fs.readFileSync(file(key));
  res.writeHead(200, { 'Content-Length': buf.length, 'Content-Type': 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : buf);
}).listen(9000, '127.0.0.1');
const url = (key) => `http://127.0.0.1:9000/${encodeURIComponent(key)}`;
const r2Client = {
  presignPut: (key, { contentType } = {}) => ({ url: url(key), method: 'PUT', headers: contentType ? { 'Content-Type': contentType } : {}, expiresAt: new Date(Date.now() + 900e3).toISOString(), objectKey: key }),
  presignHead: (key) => ({ url: url(key) }), presignGet: (key) => ({ url: url(key) }), presignDelete: (key) => ({ url: url(key) }),
  remoteRef: (key) => `r2://okb-staging-local/${key}`,
};

// Control port: toggle the R2 outage and the backend outage.
let backend = null;
async function startBackend() {
  const { createServer } = require(path.join(BACKEND, 'server.js'));
  const { offlineAi } = require(path.join(BACKEND, 'test/helpers/flood-fixtures'));
  backend = await createServer({ tokens: ['staging-device-token-0123456789'], adminTokens: ['staging-admin-token-0123456789'], log: (m) => console.log('[backend]', m), ai: offlineAi(), r2Client });
  await new Promise((r) => backend.listen(8095, '127.0.0.1', r));
  console.log('backend up on :8095');
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/r2') r2Down = u.searchParams.get('down') === '1';
  if (u.pathname === '/backend' && u.searchParams.get('down') === '1' && backend) { backend.closeAllConnections(); await new Promise((r) => backend.close(r)); backend = null; }
  if (u.pathname === '/backend' && u.searchParams.get('down') === '0' && !backend) await startBackend();
  res.end(JSON.stringify({ r2Down, backendUp: Boolean(backend) }));
}).listen(9001, '127.0.0.1');
startBackend().catch((e) => { console.error(e); process.exit(1); });
