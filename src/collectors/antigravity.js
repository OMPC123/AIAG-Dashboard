// Antigravity collector.
//   - ~/.gemini/<app>/conversation_summaries.db  -> conversations (title, run status, steps, last activity)
//   - running processes                          -> app / language server up or down
//   - optional quota probe (off by default): asks the locally running Antigravity language server
//     for the signed-in user's model quota. It reads the per-process CSRF token from the language
//     server's command line and only ever talks to 127.0.0.1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { run, runningProcessNames, HOUR, localDateKey } = require('./util');

const HOME = os.homedir();
const DEFAULT_DIRS = [
  { name: 'Antigravity', dir: path.join(HOME, '.gemini', 'antigravity') },
  { name: 'Antigravity IDE', dir: path.join(HOME, '.gemini', 'antigravity-ide') },
];

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}
let sqlJsPromise = null;

/** Rows from conversation_summaries; node:sqlite (sees WAL) preferred, sql.js as fallback. */
async function readConversations(dbFile) {
  const sql = `select conversation_id, title, preview, step_count, last_modified_time, status, agent_name,
      not_fully_idle, killed, last_user_input_time, workspace_uris, parent_conversation_id
    from conversation_summaries order by last_modified_time desc limit 200`;
  if (DatabaseSync) {
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      return db.prepare(sql).all();
    } catch {
      /* fall through to sql.js */
    } finally {
      try { db && db.close(); } catch { /* ignore */ }
    }
  }
  if (!sqlJsPromise) sqlJsPromise = require('sql.js')();
  const SQL = await sqlJsPromise;
  const db = new SQL.Database(fs.readFileSync(dbFile));
  try {
    const res = db.exec(sql)[0];
    if (!res) return [];
    return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
  } finally {
    db.close();
  }
}

function parseTime(s) {
  if (!s || String(s).startsWith('0001-')) return 0;
  // "2026-10-16 08:37:54.6705298+00:00" -> trim sub-ms digits for Date.parse
  const t = Date.parse(String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? 0 : t;
}

function workspaceName(uris) {
  if (!uris) return null;
  let first = String(uris);
  try {
    const parsed = JSON.parse(first);
    first = Array.isArray(parsed) ? parsed[0] : first;
  } catch {
    first = first.split(/[,\s]/)[0];
  }
  if (!first) return null;
  try {
    return decodeURIComponent(first.replace(/\/+$/, '').split('/').pop());
  } catch {
    return first;
  }
}

const STATUS = {
  CASCADE_RUN_STATUS_RUNNING: 'working',
  CASCADE_RUN_STATUS_IDLE: 'idle',
  CASCADE_RUN_STATUS_WAITING_FOR_USER: 'waiting',
  CASCADE_RUN_STATUS_ERROR: 'error',
};

function mapState(r, now) {
  if (Number(r.killed)) return 'ended';
  const s = String(r.status || '');
  if (STATUS[s] && STATUS[s] !== 'idle') return STATUS[s];
  if (/RUNNING|BUSY|GENERATING/.test(s)) return 'working';
  if (/WAIT/.test(s)) return 'waiting';
  if (Number(r.not_fully_idle)) return 'working';
  return now - parseTime(r.last_modified_time) < 90 * 1000 ? 'working' : 'idle';
}

// ---------- optional quota probe ----------

/** macOS / Linux: [{pid, cmd, ports}] from ps + lsof. */
async function languageServerProcsUnix() {
  const out = await run('ps', ['-axo', 'pid=,command=']);
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || !/language_server/.test(m[2].split(' ')[0])) continue;
    const lsof = await run('lsof', ['-nP', '-a', '-p', m[1], '-iTCP', '-sTCP:LISTEN']);
    const ports = [...lsof.matchAll(/:(\d+) \(LISTEN\)/g)].map((x) => Number(x[1]));
    procs.push({ pid: Number(m[1]), cmd: m[2], ports });
  }
  return procs;
}

async function languageServers() {
  const list = process.platform === 'win32' ? await languageServerProcsWin() : await languageServerProcsUnix();
  return list
    .map((p) => ({
      pid: p.pid,
      token: ((p.cmd || '').match(/--csrf_token[= ](\S+)/) || [])[1],
      ide: ((p.cmd || '').match(/--override_ide_name[= ](\S+)/) || [])[1] || 'antigravity',
      ports: (p.ports || []).filter(Boolean),
    }))
    .filter((p) => p.token && p.ports.length);
}

async function languageServerProcsWin() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='language_server.exe' OR Name='language_server_windows_x64.exe'" | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; cmd=$_.CommandLine; ports=@((Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue).LocalPort) } } | ConvertTo-Json -Compress -Depth 3`;
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  if (!out.trim()) return [];
  const list = JSON.parse(out);
  return Array.isArray(list) ? list : [list];
}

function postLocal(port, token, method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        rejectUnauthorized: false, // local self-signed cert
        timeout: 4000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': token,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

function parseUserStatus(json) {
  const us = json.userStatus || json;
  const ps = us.planStatus || {};
  const plan = ps.planInfo || {};
  const models = ((us.cascadeModelConfigData || {}).clientModelConfigs || [])
    .filter((m) => m.quotaInfo)
    .map((m) => ({
      label: m.label || (m.modelOrAlias && m.modelOrAlias.model) || 'model',
      remaining: m.quotaInfo.remainingFraction ?? 0,
      resetTime: m.quotaInfo.resetTime ? Date.parse(m.quotaInfo.resetTime) : null,
    }));
  return {
    email: us.email || null,
    name: us.name || null,
    planName: plan.planName || plan.teamsTier || null,
    promptCredits: ps.availablePromptCredits != null ? { available: Number(ps.availablePromptCredits), monthly: Number(plan.monthlyPromptCredits) || null } : null,
    flowCredits: ps.availableFlowCredits != null ? { available: Number(ps.availableFlowCredits), monthly: Number(plan.monthlyFlowCredits) || null } : null,
    models,
  };
}

async function probeQuota() {
  const servers = await languageServers();
  const results = [];
  for (const s of servers) {
    for (const port of s.ports) {
      try {
        const json = await postLocal(port, s.token, 'GetUserStatus', {
          metadata: { ideName: s.ide, extensionName: s.ide, locale: 'en' },
        });
        results.push({ pid: s.pid, ...parseUserStatus(json) });
        break;
      } catch {
        /* try the next port */
      }
    }
  }
  return results;
}

// ---------- main ----------

async function collectAntigravity(settings = {}) {
  const now = Date.now();
  const procs = await runningProcessNames();
  const appRunning = procs.has('antigravity');
  const lsRunning = [...procs].some((n) => n.startsWith('language_server'));

  let quota = null;
  let quotaError = null;
  if (settings.quotaProbe && lsRunning) {
    try {
      quota = await probeQuota();
    } catch (e) {
      quotaError = String(e.message || e);
    }
  }

  const dirs = (settings.dataDirs && settings.dataDirs.length ? settings.dataDirs.map((d) => ({ name: path.basename(d), dir: d })) : DEFAULT_DIRS);
  const out = [];
  for (const { name, dir } of dirs) {
    const dbFile = path.join(dir, 'conversation_summaries.db');
    if (!fs.existsSync(dbFile)) continue;
    let rows = [];
    let error = null;
    try {
      rows = await readConversations(dbFile);
    } catch (e) {
      error = String(e.message || e);
    }
    const conversations = rows.map((r) => ({
      id: r.conversation_id,
      title: r.title || r.preview || '(未命名對話)',
      project: workspaceName(r.workspace_uris),
      agent: r.agent_name || null,
      steps: Number(r.step_count) || 0,
      state: mapState(r, now),
      rawStatus: r.status,
      lastActivity: parseTime(r.last_modified_time),
      lastUserInput: parseTime(r.last_user_input_time),
      isChild: !!r.parent_conversation_id,
    }));

    const days = 14;
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const since = startOfToday - (days - 1) * 24 * HOUR;
    const daily = [];
    for (let i = 0; i < days; i++) {
      const d0 = since + i * 24 * HOUR;
      const inDay = conversations.filter((c) => c.lastActivity >= d0 && c.lastActivity < d0 + 24 * HOUR);
      daily.push({ date: localDateKey(d0), conversations: inDay.length, steps: inDay.reduce((n, c) => n + c.steps, 0) });
    }

    const q = quota && quota.length ? quota[0] : null;
    out.push({
      id: `antigravity:${dir}`,
      kind: 'antigravity',
      label: (settings.labels && settings.labels[dir]) || (q && q.email) || name,
      dataDir: dir,
      appRunning,
      languageServerRunning: lsRunning,
      error,
      quota: q,
      quotaEnabled: !!settings.quotaProbe,
      quotaError: quotaError || (settings.quotaProbe && lsRunning && quota && !quota.length ? '找不到可回應的 language server' : null),
      counts: {
        working: conversations.filter((c) => c.state === 'working' || c.state === 'waiting').length,
        total: conversations.length,
        today: conversations.filter((c) => c.lastActivity >= startOfToday).length,
        stepsToday: conversations.filter((c) => c.lastActivity >= startOfToday).reduce((n, c) => n + c.steps, 0),
      },
      daily,
      conversations: conversations.slice(0, 40),
      lastActivity: conversations.reduce((m, c) => Math.max(m, c.lastActivity), 0),
    });
  }
  return out;
}

module.exports = { collectAntigravity };
