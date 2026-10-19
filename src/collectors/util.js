const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(dir, predicate, out = [], depth = 0) {
  if (depth > 6) return out;
  for (const ent of listDir(dir)) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, predicate, out, depth + 1);
    else if (predicate(ent.name)) out.push(full);
  }
  return out;
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/** Names of running processes, lower-cased, without ".exe" (tasklist on Windows, ps on macOS/Linux). */
async function runningProcessNames() {
  const names = new Set();
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FO', 'CSV', '/NH']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)"/);
      if (m) names.add(m[1].toLowerCase().replace(/\.exe$/, ''));
    }
  } else {
    // comm is the full executable path on macOS, e.g. /Applications/Antigravity.app/Contents/MacOS/Antigravity
    const out = await run('ps', ['-axo', 'comm=']);
    for (const line of out.split('\n')) {
      const name = line.trim().split('/').pop();
      if (name) names.add(name.toLowerCase());
    }
  }
  return names;
}

const HOUR = 3600 * 1000;
const hourKey = (ms) => Math.floor(ms / HOUR);

function localDateKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = { readJson, listDir, walk, isPidAlive, run, runningProcessNames, HOUR, hourKey, localDateKey };
