const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  refreshSeconds: 10,
  alwaysOnTop: false,
  closeToTray: true,
  // Shown on every card collected on this machine; defaults to the computer name.
  machineName: '',
  // Serve this machine's data to other PCs on the LAN (read-only, token protected).
  share: { enabled: false, port: 47821, token: '' },
  // Other PCs running this dashboard with sharing on: [{ name, url, token }]
  remotes: [],
  claude: {
    // Extra Claude Code config dirs (CLAUDE_CONFIG_DIR) for a second CLI login, e.g. "C:\\Users\\me\\.claude-work"
    extraConfigDirs: [],
    // accountUuid -> display name
    labels: {},
  },
  antigravity: {
    // Empty = auto (~/.gemini/antigravity and ~/.gemini/antigravity-ide)
    dataDirs: [],
    labels: {},
    // Ask the locally running Antigravity language server for model quota (reads its CSRF token from the process list).
    quotaProbe: false,
  },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = merge(base[k], over[k]);
  return out;
}

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.value = DEFAULTS;
    try {
      this.value = merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      /* first run */
    }
  }

  save(next) {
    this.value = merge(DEFAULTS, next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }
}

module.exports = { Settings, DEFAULTS };
