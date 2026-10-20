// Machine-to-machine sharing over the LAN.
//   - share server: serves this machine's local snapshot at GET /api/snapshot (Bearer token, read-only) and
//     GET /api/ping?nonce=… which proves knowledge of the token with an HMAC, so callers can check who is at an
//     address WITHOUT sending the token there (the token is only sent to addresses that passed this check)
//   - remote sources: pulls other machines' snapshots and merges them into the dashboard
//   - connection code: one copy-paste string with a machine's id, name, LAN addresses, port and token
//   - rediscovery: when a machine's IP changes (DHCP), it is found again by probing the local subnet
//     on its port with nonce challenges; only the machine whose proof matches the token (and id) counts
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const API_PATH = '/api/snapshot';
const PING_PATH = '/api/ping';
const CODE_PREFIX = 'aiag1:';
let server = null;
let serverKey = '';

const newToken = () => crypto.randomBytes(18).toString('base64url');
const newMachineId = () => crypto.randomBytes(8).toString('hex');

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

/** HMAC proof that the answering machine knows the token, bound to the caller's nonce and the machine id. */
const proofFor = (token, nonce, id) => crypto.createHmac('sha256', String(token)).update(`aiag-ping|${nonce}|${id || ''}`).digest('base64url');
function proofMatches(token, nonce, id, proof) {
  const a = Buffer.from(proofFor(token, nonce, id));
  const b = Buffer.from(String(proof || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenMatches(header, token) {
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Start, restart or stop the share server to match settings.
 * getSnapshot returns the local-only snapshot; getInfo returns { id, name } of this machine.
 */
function applyShare(share, getSnapshot, onStatus, getInfo = () => ({})) {
  const key = share.enabled ? `${share.port}|${share.token}|${share.host || ''}` : '';
  if (key === serverKey) return;
  if (server) {
    server.close();
    server = null;
  }
  serverKey = key;
  if (!share.enabled) return onStatus({ running: false });

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' || (route !== API_PATH && route !== PING_PATH)) {
      res.writeHead(404).end();
      return;
    }
    if (route === PING_PATH) {
      // Challenge: answer with an HMAC of the caller's nonce. Reveals nothing without the token.
      const nonce = url.searchParams.get('nonce') || '';
      if (/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
        const { id } = getInfo();
        res.writeHead(200, headers).end(JSON.stringify({ app: 'aiag', v: 2, id: id || null, proof: proofFor(share.token, nonce, id) }));
        return;
      }
      // 0.4.0 clients: Bearer ping
      if (!tokenMatches(req.headers.authorization, share.token)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, headers).end(JSON.stringify({ app: 'aiag', ...getInfo() }));
      return;
    }
    if (!tokenMatches(req.headers.authorization, share.token)) {
      res.writeHead(401).end();
      return;
    }
    const snap = getSnapshot();
    res.writeHead(snap ? 200 : 503, headers);
    res.end(snap ? JSON.stringify(snap) : '{}');
  });
  // Slow or idle connections can't pile up.
  server.requestTimeout = 10000;
  server.headersTimeout = 8000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 64;
  server.on('error', (e) => {
    // forget this config so saving settings again (same port) retries the bind
    serverKey = '';
    server = null;
    onStatus({ running: false, error: e.code === 'EADDRINUSE' ? { key: 'err_portInUse', vars: { port: share.port } } : { text: e.message } });
  });
  server.listen(share.port, share.host || '0.0.0.0', () => onStatus({ running: true, port: share.port, addresses: lanAddresses() }));
}

const VIRTUAL_NIC = /vmware|virtualbox|vbox|vethernet|hyper-v|docker|wsl|loopback|utun|bridge|awdl|llw|tailscale|zerotier/i;

/** LAN IPv4 interfaces, real Wi-Fi/Ethernet adapters first (VMware & co. tend to be listed before them). */
function lanInterfaces() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ address: a.address, netmask: a.netmask, virtual: VIRTUAL_NIC.test(name) });
    }
  }
  return out.sort((x, y) => x.virtual - y.virtual);
}
const lanAddresses = () => lanInterfaces().map((x) => x.address);

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** Every other host on this machine's real (non-virtual) LAN subnets; at most /22 (1022 hosts) per subnet. */
function subnetHosts() {
  const mine = new Set(lanAddresses());
  const hosts = [];
  for (const nic of lanInterfaces()) {
    if (nic.virtual || !nic.netmask) continue;
    const mask = ipToInt(nic.netmask);
    const size = (~mask >>> 0) + 1;
    if (size > 1024 || size < 4) continue;
    const net = (ipToInt(nic.address) & mask) >>> 0;
    // nearest addresses first: DHCP usually hands out a new IP close to the old one
    const self = ipToInt(nic.address) - net;
    const order = Array.from({ length: size - 2 }, (_, i) => i + 1).sort((a, b) => Math.abs(a - self) - Math.abs(b - self));
    for (const i of order) {
      const ip = intToIp((net + i) >>> 0);
      if (!mine.has(ip)) hosts.push(ip);
    }
  }
  return [...new Set(hosts)];
}

// ---------- connection code ----------

function makeCode({ id, name, port, token, addresses }) {
  const hosts = [...(addresses || []), `${os.hostname().replace(/\.local$/, '')}.local`];
  const json = JSON.stringify({ i: id, n: name, p: port, t: token, h: [...new Set(hosts)] });
  return CODE_PREFIX + Buffer.from(json).toString('base64url');
}

/**
 * Accepts a connection code, or a manual "name | http://host:port | token" line.
 * Returns { id, name, urls, token } or null.
 */
function decodeCode(code) {
  try {
    const o = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    if (!o.t || !o.p || !Array.isArray(o.h) || !o.h.length) return null;
    return { id: o.i ? String(o.i) : null, name: String(o.n || o.h[0]), urls: o.h.map((h) => `http://${h}:${o.p}`), token: String(o.t) };
  } catch {
    return null;
  }
}

function parseCode(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // A connection code anywhere in the line wins, e.g. "Office | http://1.2.3.4:47821 | aiag1:…"
  // (pasting the whole code into the token field). A name typed before it is kept.
  if (s.includes(CODE_PREFIX)) {
    const m = s.match(/aiag1:[A-Za-z0-9_-]+/);
    const r = m && decodeCode(m[0]);
    if (!r) return null;
    const typedName = s.slice(0, m.index).split('|')[0].trim();
    return typedName && !typedName.startsWith(CODE_PREFIX) ? { ...r, name: typedName } : r;
  }
  const parts = s.split('|').map((x) => x.trim());
  if (parts.length === 3 && parts[1] && parts[2]) return { id: null, name: parts[0], urls: [parts[1]], token: parts[2] };
  return null;
}

function normalizeUrl(url, pathname = API_PATH) {
  let u = String(url || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try {
    const parsed = new URL(u);
    parsed.pathname = pathname;
    return parsed.toString();
  } catch {
    return null;
  }
}
/** "http://host:port" part of a URL */
const baseOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
};
function portOf(remote) {
  for (const u of remote.urls || []) {
    try {
      const p = new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).port;
      if (p) return Number(p);
    } catch {
      /* next */
    }
  }
  return 47821;
}

// ---------- pulling remote snapshots ----------

/** per remote (keyed by token): last good snapshot (shown as stale while unreachable) and the address that worked */
const lastGood = new Map();
const workingUrl = new Map();
/** "token|base" -> 'proven' | 'legacy': who answers at an address was checked before the token is sent there */
const verified = new Map();
const rk = (remote) => remote.token;
/** remotes (by token) that have answered a challenge at least once: no more 'legacy' acceptance for them */
const supportsProof = new Set();
const newNonce = () => crypto.randomBytes(18).toString('base64url');

/**
 * Challenge an address: 'proven' if it shows it knows the token (and has the expected id),
 * 'legacy' if it is an older AIAG version that can't answer challenges, null otherwise (token is not sent).
 */
async function challenge(base, remote, timeoutMs = 3000) {
  const nonce = newNonce();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${PING_PATH}?nonce=${nonce}`, { signal: ctrl.signal });
    if (res.status === 401 || res.status === 404) return 'legacy'; // 0.4.0 (Bearer-only ping) / before 0.4.0 (no ping)
    if (!res.ok) return null;
    const info = JSON.parse((await res.text()).slice(0, 4096));
    if (!info || info.app !== 'aiag' || !info.proof) return null;
    if (remote.id && info.id && info.id !== remote.id) return 'otherMachine';
    return proofMatches(remote.token, nonce, info.id, info.proof) ? 'proven' : 'badToken';
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(url, token, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token || ''}` }, signal: ctrl.signal });
    if (res.status === 401) throw Object.assign(new Error('401'), { code: 'err_badToken', final: true });
    if (!res.ok) throw Object.assign(new Error(String(res.status)), { code: 'err_http', vars: { status: res.status } });
    if (Number(res.headers.get('content-length')) > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error('too large'), { code: null, text: 'response too large' });
    const text = await res.text();
    if (text.length > MAX_SNAPSHOT_BYTES) throw Object.assign(new Error('too large'), { code: null, text: 'response too large' });
    return JSON.parse(text);
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
const ERR_RANK = { err_badToken: 0, err_otherMachine: 1, err_refused: 2, err_http: 3, err_timeout: 4 };

const REMOTE_BUDGET_MS = 4500;

/**
 * Never let one slow machine hold up a refresh: past the budget, report it as unreachable (with its last data).
 * If it is unreachable at every known address, start a background subnet scan; onFound(remote, baseUrl)
 * is called when it turns up at a new address (the next refresh then uses it).
 */
function fetchRemote(remote, { onFound, scan = true, hosts } = {}) {
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ remote, snap: lastGood.get(rk(remote)) || null, ok: false, error: { key: 'err_timeout' } }), REMOTE_BUDGET_MS);
  });
  return Promise.race([tryRemote(remote), budget])
    .then((r) => {
      if (!r.ok && scan && !(r.error && r.error.key === 'err_badToken')) maybeRediscover(remote, onFound, hosts);
      if (r.ok) scanState.delete(rk(remote));
      return r;
    })
    .finally(() => clearTimeout(timer));
}

/** Tries the address that worked last time; otherwise all addresses in parallel (an offline machine costs one timeout, not one per address). */
async function tryRemote(remote) {
  const key = rk(remote);
  const urls = (remote.urls || []).map((u) => normalizeUrl(u)).filter(Boolean);
  const known = workingUrl.get(key);
  const errors = [];
  const attempt = async (url) => {
    try {
      const vkey = `${key}|${baseOf(url)}`;
      if (!verified.has(vkey)) {
        const v = await challenge(baseOf(url), remote);
        // 'legacy' (older version, no challenge support) is trusted only at addresses from the user's code,
        // and never again once this machine has proven itself (someone else may now have its old IP).
        if (v === 'badToken') throw Object.assign(new Error('401'), { code: 'err_badToken', final: true });
        if (v === 'otherMachine') throw Object.assign(new Error('other'), { code: 'err_otherMachine' });
        if (!v || (v === 'legacy' && supportsProof.has(key))) throw Object.assign(new Error('unverified'), { code: 'err_timeout' });
        if (v === 'proven') supportsProof.add(key);
        verified.set(vkey, v);
      }
      const snap = await fetchOne(url, remote.token);
      workingUrl.set(key, url);
      lastGood.set(key, snap);
      return { remote, snap, ok: true, url };
    } catch (e) {
      errors.push(e);
      throw e;
    }
  };
  try {
    if (known) {
      try {
        return await attempt(known);
      } catch (e) {
        if (e.final) throw e;
      }
    }
    return await Promise.any(urls.filter((u) => u !== known).map(attempt));
  } catch {
    const e = errors.sort((a, b) => (ERR_RANK[a.code] ?? 9) - (ERR_RANK[b.code] ?? 9))[0];
    const error = e && e.code ? { key: e.code, vars: e.vars } : { text: e ? e.text || e.message : 'no address' };
    return { remote, snap: lastGood.get(key) || null, ok: false, error };
  }
}

// ---------- rediscovery after an IP change ----------

/** per remote: { running, failures, nextAt } — scans back off from 1 min to 10 min while a machine stays away */
const scanState = new Map();
const SCAN_MIN_MS = 60 * 1000;
const SCAN_MAX_MS = 10 * 60 * 1000;

function maybeRediscover(remote, onFound, hosts) {
  const key = rk(remote);
  const st = scanState.get(key) || { running: false, failures: 0, nextAt: 0 };
  if (st.running || Date.now() < st.nextAt) return;
  st.running = true;
  scanState.set(key, st);
  findRemote(remote, hosts ? { hosts } : {})
    .then((base) => {
      if (base) {
        workingUrl.set(key, normalizeUrl(base));
        scanState.delete(key);
        if (onFound) onFound(remote, base);
        return;
      }
      st.failures += 1;
      st.nextAt = Date.now() + Math.min(SCAN_MAX_MS, SCAN_MIN_MS * 2 ** (st.failures - 1));
    })
    .catch(() => {
      st.failures += 1;
      st.nextAt = Date.now() + SCAN_MAX_MS;
    })
    .finally(() => (st.running = false));
}

/**
 * Probe hosts on the remote's port with nonce challenges (the token itself is never sent). Resolves to
 * "http://ip:port" of the machine that proves it knows the token (and reports the same machine id, when
 * known), or null. Machines older than 0.4.1 can't answer challenges and are not rediscovered.
 */
async function findRemote(remote, { hosts = subnetHosts(), concurrency = 64, timeoutMs = 800 } = {}) {
  const port = portOf(remote);
  let found = null;
  let next = 0;
  const worker = async () => {
    while (!found && next < hosts.length) {
      const base = `http://${hosts[next++]}:${port}`;
      if ((await challenge(base, remote, timeoutMs)) === 'proven' && !found) {
        found = base;
        verified.set(`${rk(remote)}|${base}`, 'proven');
        supportsProof.add(rk(remote));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return found;
}

/** Tests only: forget cached addresses / snapshots / scan backoff. */
function _resetForTests() {
  lastGood.clear();
  workingUrl.clear();
  scanState.clear();
  verified.clear();
  supportsProof.clear();
}

module.exports = {
  _resetForTests,
  proofFor,
  applyShare, fetchRemote, findRemote, newToken, newMachineId, lanAddresses, subnetHosts, makeCode, parseCode, baseOf, API_PATH, PING_PATH,
};
