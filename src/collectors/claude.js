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

/**
 * file -> { offset, head, sessionId, cwd, model, firstTs, lastTs, keys:Set, records:[], models }
 * records: one per API response { k, ts, input, output, cacheRead, cacheWrite }. Totals are computed from
 * records with a dedupe across files, because a resumed / continued session repeats earlier responses
 * in its new transcript file.
 */
const fileCache = new Map();

const emptyBucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

function addRecord(bucket, r) {
  bucket.input += r.input;
  bucket.output += r.output;
  bucket.cacheRead += r.cacheRead;
  bucket.cacheWrite += r.cacheWrite;
  bucket.messages += 1;
}

const HEAD_BYTES = 256;
function readHead(fd, size) {
  const n = Math.min(HEAD_BYTES, size);
  const b = Buffer.alloc(n);
  fs.readSync(fd, b, 0, n, 0);
  return b.toString('base64');
}

function parseJsonlFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return fileCache.get(file) || null;
  }
  try {
    let entry = fileCache.get(file);
    // Start over when the file is new, shrank, or was rewritten (its first bytes changed).
    const head = entry && stat.size >= entry.offset && stat.size > 0 ? readHead(fd, stat.size) : null;
    if (!entry || stat.size < entry.offset || (entry.head && head !== entry.head && entry.offset >= HEAD_BYTES)) {
      entry = { offset: 0, head: null, sessionId: null, cwd: null, model: null, firstTs: 0, lastTs: 0, keys: new Set(), records: [], models: {} };
      fileCache.set(file, entry);
    }
    if (stat.size === entry.offset) return entry;

    const len = stat.size - entry.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, entry.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return entry; // no complete line yet
    entry.offset += lastNl + 1;
    if (entry.offset >= HEAD_BYTES || !entry.head) entry.head = readHead(fd, Math.min(entry.offset, stat.size));
    const text = buf.subarray(0, lastNl).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line || (line.indexOf('"usage"') < 0 && line.indexOf('"sessionId"') < 0)) continue;
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
      const k = msg.id || rec.requestId ? `${msg.id || ''}:${rec.requestId || ''}` : null;
      if (k && entry.keys.has(k)) continue;
      if (k) entry.keys.add(k);
      const ts = Date.parse(rec.timestamp) || stat.mtimeMs;
      if (!entry.firstTs || ts < entry.firstTs) entry.firstTs = ts;
      if (ts > entry.lastTs) entry.lastTs = ts;
      if (msg.model && msg.model !== '<synthetic>') {
        entry.model = msg.model;
        entry.models[msg.model] = (entry.models[msg.model] || 0) + (usage.output_tokens || 0);
      }
      entry.records.push({
        k,
        ts,
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
      });
    }
    return entry;
  } finally {
    fs.closeSync(fd);
  }
}

/** Drop cached files that are gone or no longer looked at, so a long-running app doesn't grow. */
function pruneCache(keep) {
  for (const f of fileCache.keys()) if (!keep.has(f)) fileCache.delete(f);
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

/** Claude Code's config dir: ~/.claude, or CLAUDE_CONFIG_DIR if Claude Code is set up to use another folder. */
function configDirs() {
  const custom = process.env.CLAUDE_CONFIG_DIR;
  if (custom) return [{ dir: path.resolve(custom), claudeJson: path.join(path.resolve(custom), '.claude.json') }];
  return [{ dir: path.join(HOME, '.claude'), claudeJson: path.join(HOME, '.claude.json') }];
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
        if (!s || !s.cliSessionId) continue;
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
  const lastSeen = new Map(); // org -> last time the desktop app checked usage while signed in to it
  for (const s of (j && j.samples) || []) {
    if (!s || !s.org) continue;
    if (s.t > (lastSeen.get(s.org) || 0)) lastSeen.set(s.org, s.t);
    // Empty samples: signed in, but Claude reported no usage limits (e.g. the free plan).
    if (!s.u || !Object.keys(s.u).length) continue;
    if (!byOrg.has(s.org)) byOrg.set(s.org, []);
    byOrg.get(s.org).push({ t: s.t, fiveHour: s.u.fh, sevenDay: s.u.sd });
  }
  const result = new Map();
  for (const [org, list] of byOrg) {
    list.sort((a, b) => a.t - b.t);
    result.set(org, { latest: list[list.length - 1], history: list.filter((x) => x.t >= sinceMs) });
  }
  result.lastSeen = lastSeen;
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

/** Local midnight `n` days before today (calendar days, so DST and half-hour time zones are right). */
function localDayStart(daysAgo, now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
}

function collectClaude(settings = {}) {
  const now = Date.now();
  const days = 14;
  const sinceMs = localDayStart(days - 1);
  const todayKey = localDateKey(now);
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
        hours: new Map(), // UTC hour -> bucket (24-hour chart)
        days: new Map(), // local date -> bucket
        last5h: emptyBucket(),
      });
    }
    const a = accounts.get(accountUuid);
    if (orgUuid && !a.orgUuid) a.orgUuid = orgUuid;
    return a;
  };

  for (const [acct, org] of desktop.accounts) ensure(acct, org).sources.push('desktop');

  for (const { dir, claudeJson } of configDirs()) {
    if (!fs.existsSync(dir)) continue;
    const profile = profileFromClaudeJson(claudeJson);
    const dirAccount = profile ? profile.accountUuid : `dir:${dir}`;
    const own = ensure(dirAccount, profile && profile.orgUuid);
    if (profile) own.profile = profile;
    own.sources.push(dir);

    const live = new Map(liveSessions(dir).map((s) => [s.sessionId, s]));

    const files = walk(path.join(dir, 'projects'), (n) => n.endsWith('.jsonl'));
    const parsed = [];
    for (const file of files) {
      // Transcripts untouched since before the chart window can't change any number shown; skip them.
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtime < sinceMs) continue;
      const e = parseJsonlFile(file);
      if (e && e.sessionId) parsed.push({ file, e });
    }
    pruneCache(new Set(parsed.map((x) => x.file)));

    // Each response counts once, for the earliest transcript that contains it.
    parsed.sort((x, y) => (x.e.firstTs || Infinity) - (y.e.firstTs || Infinity));
    const counted = new Set();
    for (const { file, e } of parsed) {
      const acctUuid = cliToAccount.get(e.sessionId) || dirAccount;
      const acct = ensure(acctUuid);
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
      for (const r of e.records) {
        if (r.k) {
          if (counted.has(r.k)) continue;
          counted.add(r.k);
        }
        const hk = hourKey(r.ts);
        if (!acct.hours.has(hk)) acct.hours.set(hk, emptyBucket());
        addRecord(acct.hours.get(hk), r);
        const dk = localDateKey(r.ts);
        if (!acct.days.has(dk)) acct.days.set(dk, emptyBucket());
        addRecord(acct.days.get(dk), r);
        if (now - r.ts <= 5 * HOUR) addRecord(acct.last5h, r);
        addRecord(s.tokens, r);
        if (dk === todayKey) addRecord(s.today, r);
      }
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

  const nowHour = hourKey(now);
  const out = [];
  let idx = 0;
  for (const a of accounts.values()) {
    if (a.accountUuid.startsWith('dir:') && a.sessions.size === 0) continue;
    const plan = a.orgUuid ? usage.get(a.orgUuid) : null;
    const daily = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = localDateKey(localDayStart(i));
      daily.push({ date, ...(a.days.get(date) || emptyBucket()) });
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
    idx += 1;
    out.push({
      id: a.accountUuid,
      kind: 'claude',
      // display name: renamed here > email; null -> "Claude account N"
      label: labels[a.accountUuid] || (p && (p.email || p.displayName)) || null,
      ordinal: idx,
      profile: p,
      orgUuid: a.orgUuid,
      sources: a.sources,
      plan: plan
        ? { fiveHour: plan.latest.fiveHour, sevenDay: plan.latest.sevenDay, sampledAt: plan.latest.t, history: plan.history }
        : null,
      // last time the Claude desktop app was signed in to this account here (it checks usage regularly)
      desktopLastSeen: (a.orgUuid && usage.lastSeen.get(a.orgUuid)) || null,
      // seen in the Claude desktop app on this computer
      inDesktop: desktop.accounts.has(a.accountUuid),
      today: { ...(a.days.get(todayKey) || emptyBucket()) },
      last5h: a.last5h,
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

/** Paths checked for Claude data; shown to the user when nothing is found. */
function claudeSearchPaths() {
  return [DESKTOP_DIR, ...configDirs().map((d) => d.dir)];
}

module.exports = { collectClaude, claudeSearchPaths, desktopDir, DESKTOP_DIR, localDayStart, _fileCache: fileCache };
