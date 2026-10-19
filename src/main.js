const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, screen, clipboard } = require('electron');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Worker } = require('worker_threads');
const { applyShare, fetchRemote, newToken, newMachineId, makeCode, parseCode, baseOf } = require('./remote');
const { Settings } = require('./settings');
const I18N = require('./i18n');

let win = null;
let tray = null;
let settings = null;
let timer = null;
let quitting = false;
let lastSnapshot = null;
let localSnapshot = null;
let shareStatus = { running: false };
let collecting = false;
let t = I18N.create('en');

// Pin the settings folder: Electron derives it from productName, which would move it between dev and packaged builds.
app.setPath('userData', path.join(app.getPath('appData'), 'aiag-dashboard'));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const machineName = () => (settings.value.machineName || '').trim() || os.hostname().replace(/\.local$/, '');
const tag = (item, machine, at) => ({ ...item, machine, collectedAt: at, key: `${machine}|${item.id}` });

function systemLocale() {
  const preferred = typeof app.getPreferredSystemLanguages === 'function' ? app.getPreferredSystemLanguages()[0] : null;
  return preferred || app.getLocale();
}
const currentLang = () => I18N.resolveLang(settings.value.language, systemLocale());

function applyLanguage() {
  t = I18N.create(currentLang());
  if (tray) buildTrayMenu();
  if (lastSnapshot) updateTray(lastSnapshot);
}

function shareCode() {
  if (!shareStatus.running) return null;
  return makeCode({ id: settings.value.machineId, name: machineName(), port: shareStatus.port, token: settings.value.share.token, addresses: shareStatus.addresses });
}

function applyShareSettings() {
  applyShare(
    settings.value.share,
    () => localSnapshot,
    (st) => {
      shareStatus = st;
      if (lastSnapshot) {
        lastSnapshot.share = st;
        send(lastSnapshot);
      }
    },
    () => ({ id: settings.value.machineId, name: machineName() })
  );
}

/** A remote machine turned up at a new address (its IP changed): remember it, so restarts try it first. */
function rememberRemoteAddress(remote, base) {
  settings.value.remotes = settings.value.remotes.map((r) => {
    if (r.token !== remote.token) return r;
    const others = r.urls.filter((u) => baseOf(/^https?:\/\//i.test(u) ? u : `http://${u}`) !== base);
    const isIp = (u) => /^(https?:\/\/)?\d+\.\d+\.\d+\.\d+/.test(u);
    // newest address first; keep host names like "mac.local" and the few most recent IPs
    const urls = [base, ...others.filter(isIp).slice(0, 3), ...others.filter((u) => !isIp(u))];
    return { ...r, urls, lastFoundAt: Date.now() };
  });
  settings.write();
  setTimeout(collect, 500); // show it right away instead of at the next interval
}

const send = (snap) => win && !win.isDestroyed() && win.webContents.send('snapshot', snap);

// ---------- tiny PNG generator for the tray / window icon (no binary assets needed) ----------
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
    for (const p of pending.values()) p({ claude: [], antigravity: [], errors: [{ key: 'err_collector', vars: { e: e.message } }], timings: {}, sources: null });
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
  try {
    const s = settings.value;
    const local = await collectLocal(s);
    const errors = [...local.errors];
    const at = Date.now();
    const machine = machineName();
    localSnapshot = {
      at,
      machine,
      claude: local.claude.map((a) => tag(a, machine, at)),
      antigravity: local.antigravity.map((g) => tag(g, machine, at)),
    };

    // Merge in other machines (only their own local data, so two PCs pointing at each other don't loop).
    const remotes = await Promise.all((s.remotes || []).map((r) => fetchRemote(r, { onFound: rememberRemoteAddress })));
    const machines = [{ name: machine, local: true, ok: true, at }];
    let claude = s.claude.enabled ? [...localSnapshot.claude] : [];
    let antigravity = s.antigravity.enabled ? [...localSnapshot.antigravity] : [];
    for (const r of remotes) {
      const name = r.remote.name || (r.snap && r.snap.machine) || (r.remote.urls || [])[0];
      machines.push({ name, ok: r.ok, at: r.snap && r.snap.at, address: r.ok && r.url ? baseOf(r.url) : null });
      if (!r.ok) errors.push({ key: 'err_remote', vars: { name }, cause: r.error, stale: !!r.snap });
      if (!r.snap) continue;
      const stale = !r.ok;
      if (s.claude.enabled) for (const a of r.snap.claude || []) claude.push({ ...tag(a, name, r.snap.at), remote: true, stale });
      if (s.antigravity.enabled) for (const g of r.snap.antigravity || []) antigravity.push({ ...tag(g, name, r.snap.at), remote: true, stale });
    }
    // Number unnamed accounts across all machines, then apply this machine's display names.
    let n = 0;
    for (const a of claude) {
      a.ordinal = ++n;
      if (s.claude.labels[a.id]) a.label = s.claude.labels[a.id];
    }
    for (const g of antigravity) if (s.antigravity.labels[g.id]) g.label = s.antigravity.labels[g.id];
    // Settings -> Accounts lists this machine's accounts, including ones hidden or merged below.
    const allClaude = [...claude];
    const allAg = [...antigravity];

    // An account seen here only as an empty desktop-app entry is shown by the machine that actually uses it,
    // carrying over the name given to it here.
    const localEmpty = new Map(claude.filter((a) => !a.remote && !a.plan && !a.counts.total).map((a) => [a.id, a]));
    const remoteIds = new Set(claude.filter((a) => a.remote).map((a) => a.id));
    for (const a of claude) {
      const mine = a.remote && localEmpty.get(a.id);
      if (!mine) continue;
      if (s.claude.labels[a.id]) a.label = mine.label;
      const seen = Math.max(a.desktopLastSeen || 0, mine.desktopLastSeen || 0);
      if (seen) a.desktopLastSeen = seen;
    }
    claude = claude.filter((a) => a.remote || !remoteIds.has(a.id) || !localEmpty.has(a.id));
    // Accounts the user chose to hide (Settings -> Accounts).
    claude = claude.filter((a) => !s.claude.hidden.includes(a.id));
    antigravity = antigravity.filter((g) => !s.antigravity.hidden.includes(g.id));

    lastSnapshot = {
      at, machine, machines, share: shareStatus, claude, antigravity, errors, timings: local.timings, sources: local.sources,
      // everything, including hidden accounts, for the Settings -> Accounts list
      allAccounts: { claude: allClaude, antigravity: allAg },
    };
    send(lastSnapshot);
    updateTray(lastSnapshot);
    return lastSnapshot;
  } finally {
    collecting = false;
  }
}

function updateTray(snap) {
  if (!tray) return;
  const working = snap.claude.reduce((n, a) => n + a.counts.working, 0) + snap.antigravity.reduce((n, g) => n + g.counts.working, 0);
  const anyLive = snap.claude.some((a) => a.counts.working + a.counts.idle > 0) || snap.antigravity.some((g) => g.appRunning);
  tray.setImage(icon(working ? 'working' : anyLive ? 'idle' : 'off'));
  const lines = [t('appName')];
  for (const a of snap.claude) {
    const name = a.label || t('claudeAccountN', { n: a.ordinal });
    const plan = a.plan ? ` · 5h ${a.plan.fiveHour ?? '–'}% · 7d ${a.plan.sevenDay ?? '–'}%` : '';
    lines.push(`${name}${a.remote ? ` @${a.machine}` : ''}: ${t('trayWorking', { n: a.counts.working })}${plan}`);
  }
  for (const g of snap.antigravity) lines.push(`${g.label}: ${g.appRunning ? t('trayRunning') : t('trayStopped')}`);
  // Windows caps tray tooltips at 127 characters.
  tray.setToolTip(process.platform === 'win32' ? lines.join('\n').slice(0, 127) : lines.join('\n'));
}

function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('trayOpen'), click: showWindow },
    { label: t('trayRefresh'), click: () => collect() },
    { type: 'separator' },
    { label: t('trayQuit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(collect, Math.max(3, settings.value.refreshSeconds) * 1000);
}

// ---------- window ----------

/** Bounds are remembered per view, so compact can be a small widget and full a big window. */
function savedBounds(view = settings.value.view) {
  const w = settings.value.window || {};
  if (w.width) return view === 'full' ? w : null; // older single-bounds format
  return w[view] || null;
}

/** Saved bounds for the current view, if they are still on a connected screen. */
function restoredBounds(view) {
  const w = savedBounds(view);
  if (!w || !w.width || !w.height) return {};
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return w.x + 100 > a.x && w.x < a.x + a.width - 100 && w.y >= a.y - 20 && w.y < a.y + a.height - 100;
  });
  return visible ? { x: w.x, y: w.y, width: w.width, height: w.height } : { width: w.width, height: w.height };
}

let boundsTimer = null;
function rememberBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    const current = settings.value.window && !settings.value.window.width ? settings.value.window : {};
    settings.value.window = { ...current, [settings.value.view]: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } };
    settings.write();
  }, 400);
}

function createWindow() {
  win = new BrowserWindow({
    ...(settings.value.view === 'compact' ? { width: 820, height: 360 } : { width: 1280, height: 860 }),
    ...restoredBounds(),
    minWidth: 360,
    minHeight: 320,
    title: t('appName'),
    backgroundColor: '#141413',
    icon: icon('idle'),
    autoHideMenuBar: true,
    show: false,
    alwaysOnTop: settings.value.alwaysOnTop,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  if ((savedBounds() || {}).maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => lastSnapshot && send(lastSnapshot));
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  let lastFocusRefresh = 0;
  win.on('focus', () => {
    if (Date.now() - lastFocusRefresh < 3000) return;
    lastFocusRefresh = Date.now();
    collect();
  });
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

function settingsPayload() {
  return {
    value: settings.value,
    file: settings.file,
    hostname: os.hostname().replace(/\.local$/, ''),
    platform: process.platform,
    lang: currentLang(),
    share: shareStatus,
    code: shareCode(),
  };
}

app.whenReady().then(() => {
  if (!gotLock) return;
  settings = new Settings(app.getPath('userData'));
  if (!settings.value.share.token) settings.patch({ share: { token: newToken() } });
  if (!settings.value.machineId) settings.patch({ machineId: newMachineId() });
  applyLanguage();
  applyShareSettings();

  ipcMain.handle('refresh', () => collect());
  ipcMain.handle('settings:get', () => settingsPayload());
  ipcMain.handle('settings:save', (_e, next) => {
    const v = settings.save(next);
    if (win) win.setAlwaysOnTop(!!v.alwaysOnTop);
    applyLanguage();
    applyShareSettings();
    schedule();
    collect();
    return settingsPayload();
  });
  // Small UI preferences (view mode, language, pin) that must not overwrite anything else.
  ipcMain.handle('settings:patch', (_e, partial) => {
    const allowed = {};
    for (const k of ['view', 'language', 'alwaysOnTop']) if (partial && k in partial) allowed[k] = partial[k];
    const viewChanged = 'view' in allowed && allowed.view !== settings.value.view;
    settings.patch(allowed);
    if ('alwaysOnTop' in allowed && win) win.setAlwaysOnTop(!!allowed.alwaysOnTop);
    if (viewChanged && win && !win.isDestroyed()) {
      // Jump to the size last used for this view (first time in compact: a small default).
      const b = restoredBounds(allowed.view);
      clearTimeout(boundsTimer);
      if (win.isMaximized()) win.unmaximize();
      if (b.width) win.setBounds({ ...win.getBounds(), ...b });
      else if (allowed.view === 'compact') win.setSize(820, 360);
      if ((savedBounds(allowed.view) || {}).maximized) win.maximize();
    }
    if ('language' in allowed) applyLanguage();
    return settingsPayload();
  });
  ipcMain.handle('share:newToken', () => newToken());
  ipcMain.handle('remote:parse', (_e, text) => parseCode(text));
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('open:path', (_e, p) => typeof p === 'string' && shell.openPath(p));
  ipcMain.handle('open:url', (_e, u) => typeof u === 'string' && /^https:\/\//.test(u) && shell.openExternal(u));

  tray = new Tray(icon('idle'));
  buildTrayMenu();
  tray.on('click', showWindow);

  createWindow();
  collect();
  schedule();
});

app.on('before-quit', () => (quitting = true));
// macOS: clicking the Dock icon brings the hidden window back.
app.on('activate', () => settings && showWindow());
app.on('window-all-closed', () => {
  if (settings && !settings.value.closeToTray) app.quit();
});
app.on('second-instance', () => settings && showWindow());
