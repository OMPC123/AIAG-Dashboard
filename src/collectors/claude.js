// Claude collector: reads only local files written by the Claude desktop app and Claude Code.
//   - <Roaming>/Claude/plan-usage-history.json      -> plan usage % per org (5-hour / 7-day windows)
//   - <Roaming>/Claude/claude-code-sessions/<account>/<org>/local_*.json -> desktop sessions per account
//   - <configDir>/sessions/*.json                    -> live Claude Code processes (busy / idle)
//   - <configDir>/projects/**/*.jsonl                -> per-message token usage
//   - <configDir>/.claude.json (or ~/.claude.json)   -> signed-in account profile
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, listDir, walk, isPidAlive, HOUR, hourKey, localDateKey } = require('./util');

const HOME = os.homedir();
/** Claude desktop app's data dir (Electron userData) per OS. */
function desktopDir(platform = process.platform, home = HOME, env = process.env) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude');
}
const DESKTOP_DIR = desktopDir();

// ---------- incremental JSONL token parser ----------

/** file -> { offset, sessionId, cwd, title, model, firstTs, lastTs, seen:Set, hours:Map<hourKey, bucket> } */
const fileCache = new Map();

const emptyBucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

function addUsage(bucket, u) {
  bucket.input += u.input_tokens || 0;
  bucket.output += u.output_tokens || 0;
  bucket.cacheRead += u.cache_read_input_tokens || 0;
  bucket.cacheWrite += u.cache_creation_input_tokens || 0;
  bucket.messages += 1;
}

function parseJsonlFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  let entry = fileCache.get(file);
  if (!entry || stat.size < entry.offset) {
    entry = { offset: 0, sessionId: null, cwd: null, model: null, firstTs: 0, lastTs: 0, seen: new Set(), hours: new Map(), models: {} };
    fileCache.set(file, entry);
  }
  if (stat.size === entry.offset) return entry;

  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - entry.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, entry.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return entry; // no complete line yet
    entry.offset += lastNl + 1;
    const text = buf.subarray(0, lastNl).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') < 0 && line.indexOf('"sessionId"') < 0) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.sessionId && !entry.sessionId) entry.sessionId = rec.sessionId;
      if (rec.cwd) entry.cwd = rec.cwd;
      const msg = rec.message;
      const usage = msg && msg.usage;
      if (!usage || rec.type !== 'assistant') continue;
      // One API response is written as several lines (one per content block) sharing the same usage.
      const key = `${msg.id || ''}:${rec.requestId || ''}`;
      if (key !== ':' && entry.seen.has(key)) continue;
      entry.seen.add(key);
      const ts = Date.parse(rec.timestamp) || stat.mtimeMs;
      if (!entry.firstTs || ts < entry.firstTs) entry.firstTs = ts;
      if (ts > entry.lastTs) entry.lastTs = ts;
      if (msg.model && msg.model !== '<synthetic>') {
        entry.model = msg.model;
        entry.models[msg.model] = (entry.models[msg.model] || 0) + (usage.output_tokens || 0);
      }
      const hk = hourKey(ts);
      if (!entry.hours.has(hk)) entry.hours.set(hk, emptyBucket());
      addUsage(entry.hours.get(hk), usage);
    }
  } finally {
    fs.closeSync(fd);
  }
  return entry;
}

// ---------- account discovery ----------

function profileFromClaudeJson(file) {
  const j = readJson(file);
  const oa = j && j.oauthAccount;
  if (!oa || !oa.accountUuid) return null;
  return {
    accountUuid: oa.accountUuid,
    orgUuid: oa.organizationUuid,
    email: oa.emailAddress,
    displayName: oa.displayName || oa.fullName,
    orgName: oa.organizationName,
    billingType: oa.billingType,
    rateLimitTier: oa.userRateLimitTier || oa.organizationRateLimitTier,
  };
}

/** Claude Code config dirs: the default ~/.claude plus any extra CLAUDE_CONFIG_DIR-style dirs. */
function configDirs(extraDirs) {
  const dirs = [{ dir: path.join(HOME, '.claude'), claudeJson: path.join(HOME, '.claude.json') }];
  for (const d of extraDirs || []) {
    if (!d) continue;
    const dir = path.resolve(d);
    if (dirs.some((x) => x.dir.toLowerCase() === dir.toLowerCase())) continue;
    dirs.push({ dir, claudeJson: path.join(dir, '.claude.json') });
  }
  return dirs;
}

/** Desktop app: claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json */
function desktopSessions() {
  const root = path.join(DESKTOP_DIR, 'claude-code-sessions');
  const accounts = new Map(); // accountUuid -> orgUuid
  const sessions = [];
  for (const acct of listDir(root)) {
    if (!acct.isDirectory()) continue;
    for (const org of listDir(path.join(root, acct.name))) {
      if (!org.isDirectory()) continue;
      accounts.set(acct.name, org.name);
      const dir = path.join(root, acct.name, org.name);
      for (const f of listDir(dir)) {
        if (!f.isFile() || !/^local_.*\.json$/.test(f.name)) continue;
        const s = readJson(path.join(dir, f.name));
        if (!s) continue;
        sessions.push({
          accountUuid: acct.name,
          orgUuid: org.name,
          desktopId: s.sessionId,
          cliSessionId: s.cliSessionId,
          title: s.title,
          cwd: s.cwd,
          model: s.model,
          effort: s.effort,
          archived: !!s.isArchived,
          createdAt: s.createdAt,
          lastActivityAt: s.lastActivityAt,
        });
      }
    }
  }
  return { accounts, sessions };
}

/** plan-usage-history.json: samples {t, org, u:{fh: 5-hour %, sd: 7-day %}} */
function planUsage(sinceMs) {
  const j = readJson(path.join(DESKTOP_DIR, 'plan-usage-history.json'));
  const byOrg = new Map();
  for (const s of (j && j.samples) || []) {
    if (!s || !s.org || !s.u || !Object.keys(s.u).length) continue;
    if (!byOrg.has(s.org)) byOrg.set(s.org, []);
    byOrg.get(s.org).push({ t: s.t, fiveHour: s.u.fh, sevenDay: s.u.sd });
  }
  const result = new Map();
  for (const [org, list] of byOrg) {
    list.sort((a, b) => a.t - b.t);
    result.set(org, { latest: list[list.length - 1], history: list.filter((x) => x.t >= sinceMs) });
  }
  return result;
}

function liveSessions(dir) {
  const out = [];
  const sdir = path.join(dir, 'sessions');
  for (const f of listDir(sdir)) {
    if (!f.isFile() || !f.name.endsWith('.json')) continue;
    const s = readJson(path.join(sdir, f.name));
    if (!s || !s.sessionId) continue;
    out.push({
      pid: s.pid,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.name,
      status: s.status || 'unknown',
      entrypoint: s.entrypoint,
      version: s.version,
      startedAt: s.startedAt,
      updatedAt: s.statusUpdatedAt || s.updatedAt,
      alive: isPidAlive(s.pid),
    });
  }
  return out;
}

// ---------- aggregation ----------

function sumBuckets(target, hours, fromHour, toHour) {
  for (const [hk, b] of hours) {
    if (hk < fromHour || hk > toHour) continue;
    target.input += b.input;
    target.output += b.output;
    target.cacheRead += b.cacheRead;
    target.cacheWrite += b.cacheWrite;
    target.messages += b.messages;
  }
  return target;
}

function collectClaude(settings = {}) {
  const now = Date.now();
  const days = 14;
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const sinceMs = startOfToday - (days - 1) * 24 * HOUR;
  const labels = settings.labels || {};

  const desktop = desktopSessions();
  const usage = planUsage(sinceMs);
  const cliToAccount = new Map(desktop.sessions.map((s) => [s.cliSessionId, s.accountUuid]));
  const desktopByCli = new Map(desktop.sessions.map((s) => [s.cliSessionId, s]));

  const accounts = new Map();
  const ensure = (accountUuid, orgUuid) => {
    if (!accounts.has(accountUuid)) {
      accounts.set(accountUuid, {
        accountUuid,
        orgUuid: orgUuid || null,
        profile: null,
        sources: [],
        sessions: new Map(),
        hours: new Map(),
      });
    }
    const a = accounts.get(accountUuid);
    if (orgUuid && !a.orgUuid) a.orgUuid = orgUuid;
    return a;
  };

  for (const [acct, org] of desktop.accounts) ensure(acct, org).sources.push('Claude 桌面版');

  for (const { dir, claudeJson } of configDirs(settings.extraConfigDirs)) {
    if (!fs.existsSync(dir)) continue;
    const profile = profileFromClaudeJson(claudeJson);
    const dirAccount = profile ? profile.accountUuid : `dir:${dir}`;
    const own = ensure(dirAccount, profile && profile.orgUuid);
    if (profile) own.profile = profile;
    own.sources.push(dir);

    const live = new Map(liveSessions(dir).map((s) => [s.sessionId, s]));

    const files = walk(path.join(dir, 'projects'), (n) => n.endsWith('.jsonl'));
    for (const file of files) {
      const e = parseJsonlFile(file);
      if (!e || !e.sessionId) continue;
      const acctUuid = cliToAccount.get(e.sessionId) || dirAccount;
      const acct = ensure(acctUuid);
      for (const [hk, b] of e.hours) {
        if (!acct.hours.has(hk)) acct.hours.set(hk, emptyBucket());
        const t = acct.hours.get(hk);
        t.input += b.input; t.output += b.output; t.cacheRead += b.cacheRead; t.cacheWrite += b.cacheWrite; t.messages += b.messages;
      }
      const isSubagent = /[\\/]subagents[\\/]/.test(file);
      let s = acct.sessions.get(e.sessionId);
      if (!s) {
        const d = desktopByCli.get(e.sessionId);
        s = {
          sessionId: e.sessionId,
          title: (d && d.title) || null,
          cwd: e.cwd || (d && d.cwd),
          model: e.model || (d && d.model),
          lastTs: 0,
          firstTs: 0,
          subagents: 0,
          tokens: emptyBucket(),
          today: emptyBucket(),
          models: {},
        };
        acct.sessions.set(e.sessionId, s);
      }
      if (isSubagent) s.subagents += 1;
      if (e.lastTs > s.lastTs) s.lastTs = e.lastTs;
      if (e.firstTs && (!s.firstTs || e.firstTs < s.firstTs)) s.firstTs = e.firstTs;
      if (!isSubagent && e.model) s.model = e.model;
      for (const [m, n] of Object.entries(e.models)) s.models[m] = (s.models[m] || 0) + n;
      sumBuckets(s.tokens, e.hours, -Infinity, Infinity);
      sumBuckets(s.today, e.hours, hourKey(startOfToday), Infinity);
    }

    // Attach live process state (sessions with no JSONL yet still show up).
    for (const l of live.values()) {
      const acct = ensure(cliToAccount.get(l.sessionId) || dirAccount);
      let s = acct.sessions.get(l.sessionId);
      if (!s) {
        s = { sessionId: l.sessionId, title: null, cwd: l.cwd, model: null, lastTs: 0, firstTs: l.startedAt, subagents: 0, tokens: emptyBucket(), today: emptyBucket(), models: {} };
        acct.sessions.set(l.sessionId, s);
      }
      s.live = l;
      if (l.name) s.title = s.title || l.name;
    }
  }

  // Desktop sessions that have no local transcript (e.g. other account, archived) still count as known sessions.
  for (const d of desktop.sessions) {
    const acct = ensure(d.accountUuid, d.orgUuid);
    if (!acct.sessions.has(d.cliSessionId)) {
      acct.sessions.set(d.cliSessionId, {
        sessionId: d.cliSessionId, title: d.title, cwd: d.cwd, model: d.model, lastTs: d.lastActivityAt || 0,
        firstTs: d.createdAt, subagents: 0, tokens: emptyBucket(), today: emptyBucket(), models: {},
      });
    }
    const s = acct.sessions.get(d.cliSessionId);
    s.archived = d.archived;
    s.desktopLastActivity = d.lastActivityAt;
  }

  const todayHour = hourKey(startOfToday);
  const nowHour = hourKey(now);
  const out = [];
  let idx = 0;
  for (const a of accounts.values()) {
    if (a.accountUuid.startsWith('dir:') && a.sessions.size === 0) continue;
    const plan = a.orgUuid ? usage.get(a.orgUuid) : null;
    const daily = [];
    for (let i = 0; i < days; i++) {
      const dayStart = sinceMs + i * 24 * HOUR;
      daily.push({ date: localDateKey(dayStart), ...sumBuckets(emptyBucket(), a.hours, hourKey(dayStart), hourKey(dayStart) + 23) });
    }
    const hourly = [];
    for (let h = nowHour - 23; h <= nowHour; h++) {
      hourly.push({ t: h * HOUR, ...(a.hours.get(h) || emptyBucket()) });
    }
    const sessions = [...a.sessions.values()]
      .map((s) => {
        const alive = s.live && s.live.alive;
        const recent = now - Math.max(s.lastTs || 0, s.desktopLastActivity || 0) < 2 * 60 * 1000;
        let state = 'ended';
        if (alive) state = s.live.status === 'busy' || recent ? 'working' : 'idle';
        else if (s.archived) state = 'archived';
        return {
          sessionId: s.sessionId,
          title: s.title,
          project: s.cwd ? path.basename(s.cwd) : null,
          cwd: s.cwd,
          model: s.model,
          state,
          entrypoint: s.live && s.live.entrypoint,
          lastActivity: Math.max(s.lastTs || 0, s.desktopLastActivity || 0, (s.live && s.live.updatedAt) || 0),
          startedAt: s.firstTs,
          subagents: s.subagents,
          tokens: s.tokens,
          today: s.today,
        };
      })
      .sort((x, y) => rank(x.state) - rank(y.state) || y.lastActivity - x.lastActivity);

    const p = a.profile;
    const fallbackName = `Claude 帳號 ${++idx}`;
    out.push({
      id: a.accountUuid,
      kind: 'claude',
      label: labels[a.accountUuid] || (p && (p.email || p.displayName)) || fallbackName,
      profile: p,
      orgUuid: a.orgUuid,
      sources: a.sources,
      plan: plan
        ? { fiveHour: plan.latest.fiveHour, sevenDay: plan.latest.sevenDay, sampledAt: plan.latest.t, history: plan.history }
        : null,
      today: sumBuckets(emptyBucket(), a.hours, todayHour, Infinity),
      last5h: sumBuckets(emptyBucket(), a.hours, nowHour - 4, Infinity),
      daily,
      hourly,
      counts: {
        working: sessions.filter((s) => s.state === 'working').length,
        idle: sessions.filter((s) => s.state === 'idle').length,
        total: sessions.length,
      },
      sessions: sessions.slice(0, 40),
      lastActivity: sessions.reduce((m, s) => Math.max(m, s.lastActivity || 0), 0),
    });
  }
  return out;
}

function rank(state) {
  return { working: 0, idle: 1, ended: 2, archived: 3 }[state] ?? 4;
}

module.exports = { collectClaude, desktopDir, DESKTOP_DIR };
