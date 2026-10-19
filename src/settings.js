const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  language: 'auto', // 'auto' | 'zh-TW' | 'en'
  view: 'full', // 'full' | 'compact'
  refreshSeconds: 10,
  alwaysOnTop: false,
  closeToTray: true,
  // Restored on next launch: { x, y, width, height, maximized }
  window: null,
  // Shown on every card collected on this machine; defaults to the computer name.
  machineName: '',
  // Stable random id of this machine (in its connection code), so a rescan after an IP change finds the right one.
  machineId: '',
  // Serve this machine's data to other PCs on the LAN (read-only, token protected).
  share: { enabled: false, port: 47821, token: '' },
  // Other PCs running this dashboard with sharing on: [{ name, urls: [..], token }]
  remotes: [],
  claude: {
    enabled: true,
    // account id -> display name
    labels: {},
    // account ids not shown on the dashboard
    hidden: [],
  },
  antigravity: {
    enabled: true,
    // Empty = auto-detect
    dataDirs: [],
    labels: {},
    hidden: [],
    // Ask the locally running Antigravity language server for model quota (reads its CSRF token from the process list).
    quotaProbe: false,
  },
};

function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
  return out;
}

/**
 * Older files: a single `url` per remote; added accounts / extra config dirs (0.3.0, since removed:
 * one computer only runs one Claude account at a time).
 */
function migrate(v) {
  delete v.claude.accounts;
  delete v.claude.extraConfigDirs;
  delete v.claude.cliPath;
  v.claude.hidden = (v.claude.hidden || []).filter((h) => !String(h).startsWith('account:'));
  v.remotes = (v.remotes || [])
    .map((r) => ({ name: r.name || '', urls: r.urls || (r.url ? [r.url] : []), token: r.token || '', id: r.id || null }))
    .filter((r) => r.urls.length);
  return v;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.value = merge(DEFAULTS, {});
    if (!fs.existsSync(this.file)) return;
    try {
      this.value = migrate(merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8'))));
    } catch {
      // Keep the unreadable file for inspection instead of silently overwriting it later.
      try {
        fs.copyFileSync(this.file, `${this.file}.broken-${Date.now()}`);
      } catch {
        /* ignore */
      }
    }
  }

  /** Replace everything (from the settings dialog). */
  save(next) {
    this.value = migrate(merge(DEFAULTS, next));
    this.write();
    return this.value;
  }

  /** Merge a few keys (view, language, window bounds...) without touching the rest. */
  patch(partial) {
    this.value = migrate(merge(this.value, partial));
    this.write();
    return this.value;
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, this.file); // atomic: a crash never leaves a half-written file
  }
}

module.exports = { Settings, DEFAULTS };
