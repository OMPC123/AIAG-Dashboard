// Machine-to-machine sharing over the LAN.
//   - share server: serves this machine's local snapshot at GET /api/snapshot (Bearer token required, read-only)
//   - remote sources: pulls other machines' snapshots and merges them into the dashboard
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const API_PATH = '/api/snapshot';
let server = null;
let serverKey = '';

const newToken = () => crypto.randomBytes(18).toString('base64url');

function tokenMatches(header, token) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Start, restart or stop the share server to match settings. getSnapshot returns the local-only snapshot. */
function applyShare(share, getSnapshot, onStatus) {
  const key = share.enabled ? `${share.port}|${share.token}` : '';
  if (key === serverKey) return;
  if (server) {
    server.close();
    server = null;
  }
  serverKey = key;
  if (!share.enabled) return onStatus({ running: false });

  server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== API_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (!tokenMatches(req.headers.authorization, share.token)) {
      res.writeHead(401).end();
      return;
    }
    const snap = getSnapshot();
    res.writeHead(snap ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(snap ? JSON.stringify(snap) : '{}');
  });
  server.on('error', (e) => onStatus({ running: false, error: e.code === 'EADDRINUSE' ? `連接埠 ${share.port} 已被使用` : e.message }));
  server.listen(share.port, share.host || '0.0.0.0', () => onStatus({ running: true, port: share.port, addresses: lanAddresses() }));
}

const VIRTUAL_NIC = /vmware|virtualbox|vbox|vethernet|hyper-v|docker|wsl|loopback|utun|bridge|awdl|llw|tailscale|zerotier/i;

/** LAN IPv4 addresses, real Wi-Fi/Ethernet adapters first (VMware & co. tend to be listed before them). */
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, virtual: VIRTUAL_NIC.test(name) });
    }
  }
  return out.sort((x, y) => x.virtual - y.virtual).map((x) => x.address);
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  const parsed = new URL(u);
  if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = API_PATH;
  return parsed.toString();
}

/** last good snapshot per remote url, so a briefly unreachable machine still shows (marked stale) */
const lastGood = new Map();

async function fetchRemote(remote) {
  const url = normalizeUrl(remote.url);
  if (!url) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${remote.token || ''}` }, signal: ctrl.signal });
    clearTimeout(timer);
    if (res.status === 401) throw new Error('token 不正確');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    lastGood.set(url, snap);
    return { remote, snap, ok: true };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '連線逾時' : e.cause && e.cause.code === 'ECONNREFUSED' ? '連線被拒（對方未開啟分享？）' : e.message;
    return { remote, snap: lastGood.get(url) || null, ok: false, error: msg };
  }
}

module.exports = { applyShare, fetchRemote, newToken, lanAddresses, API_PATH };
