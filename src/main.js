const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { applyShare, fetchRemote, newToken } = require('./remote');
const { Worker } = require('worker_threads');
const { Settings } = require('./settings');

let win = null;
let tray = null;
let settings = null;
let timer = null;
let quitting = false;
let lastSnapshot = null;
let localSnapshot = null;
let shareStatus = { running: false };
let collecting = false;

const machineName = () => (settings.value.machineName || '').trim() || os.hostname();
const tag = (item, machine, at) => ({ ...item, machine, collectedAt: at, key: `${machine}|${item.id}` });

function applyShareSettings() {
  applyShare(settings.value.share, () => localSnapshot, (st) => {
    shareStatus = st;
    if (lastSnapshot) {
      lastSnapshot.share = st;
      if (win && !win.isDestroyed()) win.webContents.send('snapshot', lastSnapshot);
    }
  });
}

// ---------- tiny PNG generator for the tray icon (no binary assets needed) ----------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function dotIcon(hex, size = 32) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = (size - 1) / 2, R = size * 0.42, ring = size * 0.30;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const a = Math.max(0, Math.min(1, R - d + 0.5));
      const inner = d < ring;
      raw[o] = inner ? r : 0x1a; raw[o + 1] = inner ? g : 0x1a; raw[o + 2] = inner ? b : 0x19;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  // macOS menu bar expects ~16pt icons: treat the 32px bitmap as @2x.
  return nativeImage.createFromBuffer(png, { scaleFactor: process.platform === 'darwin' ? 2 : 1 });
}
const ICONS = {};
const icon = (state) => (ICONS[state] ||= dotIcon({ working: '#0ca30c', idle: '#3987e5', off: '#8a8984' }[state]));

// ---------- data ----------
let worker = null;
let workerSeq = 0;
const pending = new Map();

function startWorker() {
  worker = new Worker(path.join(__dirname, 'collectors', 'worker.js'));
  worker.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
  });
  worker.on('error', (e) => {
    for (const p of pending.values()) p({ claude: [], antigravity: [], errors: [`收集程序錯誤：${e.message}`], timings: {} });
    pending.clear();
    worker = null; // restarted on the next refresh
  });
}

/** Local data from the collector worker thread; the window stays responsive while it parses. */
function collectLocal(s) {
  if (!worker) startWorker();
  return new Promise((resolve) => {
    const id = ++workerSeq;
    pending.set(id, resolve);
    worker.postMessage({ id, settings: { claude: s.claude, antigravity: s.antigravity } });
  });
}

async function collect() {
  if (collecting) return lastSnapshot;
  collecting = true;
  const s = settings.value;
  const local = await collectLocal(s);
  const errors = [...local.errors];
  let { claude, antigravity } = local;
  const at = Date.now();
  const machine = machineName();
  localSnapshot = { at, machine, claude: claude.map((a) => tag(a, machine, at)), antigravity: antigravity.map((g) => tag(g, machine, at)) };

  // Merge in other machines (only their own local data, so two PCs pointing at each other don't loop).
  const remotes = await Promise.all((s.remotes || []).filter((r) => r.url).map(fetchRemote));
  const machines = [{ name: machine, local: true, ok: true, at }];
  claude = [...localSnapshot.claude];
  antigravity = [...localSnapshot.antigravity];
  for (const r of remotes) {
    const name = r.remote.name || (r.snap && r.snap.machine) || r.remote.url;
    machines.push({ name, url: r.remote.url, ok: r.ok, error: r.error, at: r.snap && r.snap.at });
    if (!r.ok) errors.push(`遠端「${name}」：${r.error}${r.snap ? '（顯示上次取得的資料）' : ''}`);
    if (!r.snap) continue;
    const stale = !r.ok;
    for (const a of r.snap.claude || []) claude.push({ ...tag(a, name, r.snap.at), remote: true, stale });
    for (const g of r.snap.antigravity || []) antigravity.push({ ...tag(g, name, r.snap.at), remote: true, stale });
  }
  // An account seen locally only as an empty desktop-app entry is shown by the machine that actually uses it.
  const remoteIds = new Set(claude.filter((a) => a.remote).map((a) => a.id));
  claude = claude.filter((a) => a.remote || !remoteIds.has(a.id) || a.plan || a.counts.total > 0);
  const labels = s.claude.labels || {};
  for (const a of claude) if (labels[a.id]) a.label = labels[a.id];
  for (const g of antigravity) if (labels[g.id]) g.label = labels[g.id];

  collecting = false;
  lastSnapshot = { at, machine, machines, share: shareStatus, claude, antigravity, errors, timings: local.timings };
  if (win && !win.isDestroyed()) win.webContents.send('snapshot', lastSnapshot);
  updateTray(lastSnapshot);
  return lastSnapshot;
}

function updateTray(snap) {
  if (!tray) return;
  const working = snap.claude.reduce((n, a) => n + a.counts.working, 0) + snap.antigravity.reduce((n, g) => n + g.counts.working, 0);
  const anyLive = snap.claude.some((a) => a.counts.working + a.counts.idle > 0) || snap.antigravity.some((g) => g.appRunning);
  tray.setImage(icon(working ? 'working' : anyLive ? 'idle' : 'off'));
  const lines = ['AIAG Dashboard'];
  for (const a of snap.claude) {
    const plan = a.plan ? ` 5h ${a.plan.fiveHour ?? '–'}% · 7d ${a.plan.sevenDay ?? '–'}%` : '';
    lines.push(`${a.label}${a.remote ? ` @${a.machine}` : ''}: ${a.counts.working} 工作中${plan}`);
  }
  for (const g of snap.antigravity) lines.push(`${g.label}: ${g.appRunning ? '執行中' : '未啟動'}`);
  tray.setToolTip(lines.join('\n').slice(0, 127));
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(collect, Math.max(3, settings.value.refreshSeconds) * 1000);
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    title: 'AIAG Dashboard',
    backgroundColor: '#141413',
    icon: icon('idle'),
    autoHideMenuBar: true,
    alwaysOnTop: settings.value.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => lastSnapshot && win.webContents.send('snapshot', lastSnapshot));
  win.on('close', (e) => {
    if (!quitting && settings.value.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'));
  if (!settings.value.share.token) settings.save({ ...settings.value, share: { ...settings.value.share, token: newToken() } });
  applyShareSettings();

  ipcMain.handle('refresh', () => collect());
  ipcMain.handle('settings:get', () => ({ value: settings.value, file: settings.file, hostname: os.hostname(), share: shareStatus }));
  ipcMain.handle('share:newToken', () => newToken());
  ipcMain.handle('settings:save', (_e, next) => {
    const v = settings.save(next);
    if (win) win.setAlwaysOnTop(!!v.alwaysOnTop);
    applyShareSettings();
    schedule();
    collect();
    return v;
  });
  ipcMain.handle('window:alwaysOnTop', (_e, on) => {
    settings.save({ ...settings.value, alwaysOnTop: !!on });
    win && win.setAlwaysOnTop(!!on);
    return !!on;
  });
  ipcMain.handle('open:path', (_e, p) => typeof p === 'string' && shell.openPath(p));

  tray = new Tray(icon('idle'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 Dashboard', click: showWindow },
    { label: '立即重新整理', click: () => collect() },
    { type: 'separator' },
    { label: '結束', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);

  createWindow();
  collect();
  schedule();
});

app.on('before-quit', () => (quitting = true));
// macOS: clicking the Dock icon brings the hidden window back.
app.on('activate', () => settings && showWindow());
app.on('window-all-closed', () => {
  if (!settings.value.closeToTray) app.quit();
});

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', showWindow);
