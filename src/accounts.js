// Claude accounts added in the dashboard. Each account is its own Claude Code profile folder (CLAUDE_CONFIG_DIR).
// Signing in uses Claude Code's official `claude auth login` in a terminal window, so the dashboard never
// sees passwords or tokens: Claude Code stores the credentials itself, per profile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOME = os.homedir();
const ACCOUNTS_ROOT = path.join(HOME, '.claude-accounts');
const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'claude.exe' : 'claude';

// ---------- finding the Claude Code CLI ----------

function desktopAppDir() {
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Claude');
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Claude');
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Newest copy bundled with the Claude desktop app: claude-code/<version>/<build>/claude(.exe) */
function bundledCli() {
  const root = path.join(desktopAppDir(), 'claude-code');
  let versions = [];
  try {
    versions = fs.readdirSync(root).filter((v) => /^\d+\.\d+\.\d+/.test(v));
  } catch {
    return null;
  }
  const num = (v) => v.split(/[.-]/).map((x) => Number(x) || 0);
  versions.sort((a, b) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
  for (const v of versions) {
    let builds = [];
    try {
      builds = fs.readdirSync(path.join(root, v));
    } catch {
      continue;
    }
    for (const b of builds) {
      const p = path.join(root, v, b, EXE);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/**
 * Claude Code CLI: the path set in settings, then PATH, then the usual install folders
 * (an app opened from Finder has a minimal PATH), then the copy inside the Claude desktop app.
 */
function findClaudeCli(override) {
  if (override && isFile(override)) return { path: override, source: 'settings' };
  try {
    const out = execFileSync(IS_WIN ? 'where' : 'which', [IS_WIN ? 'claude' : 'claude'], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((p) => p && (!IS_WIN || /\.(exe|cmd)$/i.test(p)));
    if (first) return { path: first, source: 'path' };
  } catch {
    /* not on PATH */
  }
  const candidates = IS_WIN
    ? [path.join(HOME, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')]
    : [path.join(HOME, '.local', 'bin', 'claude'), path.join(HOME, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const p of candidates) if (isFile(p)) return { path: p, source: 'install' };
  const bundled = bundledCli();
  if (bundled) return { path: bundled, source: 'desktop' };
  return null;
}

// ---------- launching in a terminal ----------

/** Environment for a profile: no inherited Claude / Anthropic auth, only this account's config dir. */
function profileEnv(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC|CLAUDECODE)/i.test(k) || k === 'AI_AGENT' || k === 'ELECTRON_RUN_AS_NODE') continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = dir;
  return env;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Opens a visible terminal window running `cli args...` with CLAUDE_CONFIG_DIR=dir. */
function openTerminal({ cli, args, dir, cwd, title }) {
  cwd = cwd || HOME;
  if (IS_WIN) {
    // start "<title>" opens a new console window; /k keeps it open so the user can read the result.
    // cmd /k ""C:\path with spaces\claude.exe" auth login": the outer quotes are stripped by cmd.
    const quoted = [cli, ...args].map((a) => (/[\s&()^]/.test(a) ? `"${a}"` : a)).join(' ');
    const safeTitle = String(title).replace(/["&^|<>%]/g, '');
    const child = spawn('cmd.exe', ['/d', '/c', 'start', `"${safeTitle}"`, 'cmd.exe', '/k', `"${quoted}"`], {
      cwd,
      env: profileEnv(dir),
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    return;
  }
  const unset = 'unset $(env | cut -d= -f1 | grep -E "^(CLAUDE|ANTHROPIC|CLAUDECODE)") 2>/dev/null;';
  const line = `cd ${shQuote(cwd)}; ${unset} export CLAUDE_CONFIG_DIR=${shQuote(dir)}; ${[cli, ...args].map(shQuote).join(' ')}`;
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(line)}\nend tell`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
    try {
      execFileSync('which', [term], { stdio: 'ignore' });
      const a = term === 'gnome-terminal' ? ['--', 'bash', '-lc', `${line}; exec bash`] : ['-e', 'bash', '-lc', `${line}; exec bash`];
      spawn(term, a, { detached: true, stdio: 'ignore', env: profileEnv(dir) }).unref();
      return;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('no terminal emulator found');
}

// ---------- account records ----------

function slugify(name) {
  const s = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '') // keep letters of any language (中文 folder names are fine)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .slice(0, 32);
  return s || 'account';
}

/** New account: a fresh, empty profile folder under ~/.claude-accounts/ */
function createAccount(name, existing = []) {
  const base = slugify(name);
  let dir = path.join(ACCOUNTS_ROOT, base);
  for (let n = 2; fs.existsSync(dir) || existing.some((a) => path.resolve(a.dir) === dir); n++) dir = path.join(ACCOUNTS_ROOT, `${base}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  return { id: crypto.randomBytes(6).toString('hex'), name: String(name).trim() || base, dir };
}

/** Use an existing CLAUDE_CONFIG_DIR folder as an account. */
function accountFromFolder(dir, name) {
  return { id: crypto.randomBytes(6).toString('hex'), name: String(name || '').trim() || path.basename(dir), dir: path.resolve(dir) };
}

function loginAccount(account, cliOverride) {
  const cli = findClaudeCli(cliOverride);
  if (!cli) throw Object.assign(new Error('Claude Code not found'), { code: 'noCli' });
  fs.mkdirSync(account.dir, { recursive: true });
  openTerminal({ cli: cli.path, args: ['auth', 'login'], dir: account.dir, title: `Claude login - ${account.name}` });
  return cli;
}

function logoutAccount(account, cliOverride) {
  const cli = findClaudeCli(cliOverride);
  if (!cli) throw Object.assign(new Error('Claude Code not found'), { code: 'noCli' });
  openTerminal({ cli: cli.path, args: ['auth', 'logout'], dir: account.dir, title: `Claude logout - ${account.name}` });
  return cli;
}

function openClaude(account, cliOverride, cwd) {
  const cli = findClaudeCli(cliOverride);
  if (!cli) throw Object.assign(new Error('Claude Code not found'), { code: 'noCli' });
  openTerminal({ cli: cli.path, args: [], dir: account.dir, cwd, title: `Claude Code - ${account.name}` });
  return cli;
}

/** One-line command to use this account from any terminal. */
function shellCommand(account) {
  if (IS_WIN) return `$env:CLAUDE_CONFIG_DIR="${account.dir}"; claude`;
  return `CLAUDE_CONFIG_DIR=${shQuote(account.dir)} claude`;
}

module.exports = { ACCOUNTS_ROOT, findClaudeCli, createAccount, accountFromFolder, loginAccount, logoutAccount, openClaude, shellCommand, profileEnv };
