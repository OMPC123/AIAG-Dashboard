// Machine-to-machine sharing over the LAN.
//   - share server: serves this machine's local snapshot at GET /api/snapshot (Bearer token required, read-only)
//   - remote sources: pulls other machines' snapshots and merges them into the dashboard
//   - connection code: one copy-paste string with a machine's name, LAN addresses, port and token
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const API_PATH = '/api/snapshot';
const CODE_PREFIX = 'aiag1:';
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
  server.on('error', (e) =>
    onStatus({ running: false, error: e.code === 'EADDRINUSE' ? { key: 'err_portInUse', vars: { port: share.port } } : { text: e.message } })
  );
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

// ---------- connection code ----------

function makeCode({ name, port, token, addresses }) {
  const hosts = [...(addresses || []), `${os.hostname().replace(/\.local$/, '')}.local`];
  const json = JSON.stringify({ n: name, p: port, t: token, h: [...new Set(hosts)] });
  return CODE_PREFIX + Buffer.from(json).toString('base64url');
}

/**
 * Accepts a connection code, or a manual "name | http://host:port | token" line.
 * Returns { name, urls, token } or null.
 */
function parseCode(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.startsWith(CODE_PREFIX)) {
    try {
      const o = JSON.parse(Buffer.from(s.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
      if (!o.t || !o.p || !Array.isArray(o.h) || !o.h.length) return null;
      return { name: String(o.n || o.h[0]), urls: o.h.map((h) => `http://${h}:${o.p}`), token: String(o.t) };
    } catch {
      return null;
    }
  }
  const parts = s.split('|').map((x) => x.trim());
  if (parts.length === 3 && parts[1] && parts[2]) return { name: parts[0], urls: [parts[1]], token: parts[2] };
  return null;
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = API_PATH;
    return parsed.toString();
  } catch {
    return null;
  }
}

// ---------- pulling remote snapshots ----------

/** per remote: last good snapshot (shown as stale while unreachable) and the address that worked */
const lastGood = new Map();
const workingUrl = new Map();

async function fetchOne(url, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token || ''}` }, signal: ctrl.signal });
    if (res.status === 401) throw Object.assign(new Error('401'), { code: 'err_badToken', final: true });
    if (!res.ok) throw Object.assign(new Error(String(res.status)), { code: 'err_http', vars: { status: res.status } });
    return await res.json();
  } catch (e) {
    if (typeof e.code === 'string' && e.code.startsWith('err_')) throw e;
    // Fresh errors: an AbortError is a DOMException whose `code` is a read-only number.
    if (e.name === 'AbortError') throw Object.assign(new Error('timeout'), { code: 'err_timeout' });
    const cause = e.cause && e.cause.code;
    if (cause === 'ECONNREFUSED') throw Object.assign(new Error(cause), { code: 'err_refused' });
    if (cause === 'ETIMEDOUT' || cause === 'UND_ERR_CONNECT_TIMEOUT') throw Object.assign(new Error(cause), { code: 'err_timeout' });
    throw Object.assign(new Error(cause || e.message), { code: null, text: cause || e.message });
  } finally {
    clearTimeout(timer);
  }
}

/** Most useful error to show when every address failed: wrong token > refused > HTTP > timeout > other. */
const ERR_RANK = { err_badToken: 0, err_refused: 1, err_http: 2, err_timeout: 3 };

const REMOTE_BUDGET_MS = 4500;

/** Never let one slow machine hold up a refresh: past the budget, report it as unreachable (with its last data). */
function fetchRemote(remote) {
  const id = `${remote.name}|${remote.token}`;
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ remote, snap: lastGood.get(id) || null, ok: false, error: { key: 'err_timeout' } }), REMOTE_BUDGET_MS);
  });
  return Promise.race([tryRemote(remote), budget]).finally(() => clearTimeout(timer));
}

/** Tries the address that worked last time; otherwise all addresses in parallel (an offline machine costs one timeout, not one per address). */
async function tryRemote(remote) {
  const id = `${remote.name}|${remote.token}`;
  const urls = (remote.urls || []).map(normalizeUrl).filter(Boolean);
  const errors = [];
  const attempt = async (url) => {
    try {
      const snap = await fetchOne(url, remote.token);
      workingUrl.set(id, url);
      lastGood.set(id, snap);
      return { remote, snap, ok: true, url };
    } catch (e) {
      errors.push(e);
      throw e;
    }
  };
  const known = workingUrl.get(id);
  try {
    if (known && urls.includes(known)) {
      try {
        return await attempt(known);
      } catch (e) {
        if (e.final) throw e;
      }
    }
    return await Promise.any(urls.filter((u) => u !== known || !urls.includes(known)).map(attempt));
  } catch {
    const e = errors.sort((a, b) => (ERR_RANK[a.code] ?? 9) - (ERR_RANK[b.code] ?? 9))[0];
    const error = e && e.code ? { key: e.code, vars: e.vars } : { text: e ? e.text || e.message : 'no address' };
    return { remote, snap: lastGood.get(id) || null, ok: false, error };
  }
}

module.exports = { applyShare, fetchRemote, newToken, lanAddresses, makeCode, parseCode, API_PATH };
