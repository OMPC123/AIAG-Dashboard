/* global dashboard, I18N */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-4)'];
const AG_COLOR = 'var(--series-3)';

let snapshot = null;
let prefs = null; // settings payload from main: { value, lang, platform, ... }
let t = I18N.create('en');

// ---------- i18n ----------
function applyStaticText() {
  document.documentElement.lang = t.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
}
/** errors arrive as { key, vars } / { text } (or plain strings from older versions on other machines) */
function errText(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (e.key) {
    const vars = e.cause ? { ...e.vars, e: errText(e.cause) } : e.vars;
    return t(e.key, vars) + (e.stale ? t('err_remoteStale') : '');
  }
  return e.text || '';
}

// ---------- formatting ----------
function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 1 : 2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
function rel(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return t('justNow');
  if (s < 60) return t('secAgo', { n: s });
  if (s < 3600) return t('minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('hourAgo', { n: Math.floor(s / 3600) });
  return t('dayAgo', { n: Math.floor(s / 86400) });
}
function until(ts) {
  if (!ts) return '';
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 0) return t('resetSoon');
  if (m < 60) return t('resetInMin', { m });
  if (m < 1440) return t('resetInHour', { h: Math.floor(m / 60), m: m % 60 });
  return t('resetInDay', { d: Math.floor(m / 1440) });
}
const stateTag = (st) => `<span class="state ${st}"><i></i>${esc(t('st_' + st))}</span>`;
function level(pct) {
  const cls = pct >= 95 ? 'critical' : pct >= 80 ? 'serious' : pct >= 60 ? 'warning' : 'good';
  return [cls, t('lv_' + cls)];
}
const accountName = (a) => a.label || t('claudeAccountN', { n: a.ordinal || 1 });
const machineTag = (x) =>
  `<span class="machine${x.remote ? ' remote' : ''}${x.stale ? ' stale' : ''}" title="${esc(x.stale ? t('staleTitle', { when: rel(x.collectedAt) }) : t('machineTitle'))}">💻 ${esc(x.machine)}${x.stale ? ' · ' + esc(t('offline')) : ''}</span>`;
const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');
const dateTime = (ms, opts) => new Date(ms).toLocaleString(t.lang, opts);
/** Nothing to chart: no plan %, no Claude Code activity (e.g. a free-plan account used only on claude.ai / the desktop app). */
const noData = (a) => !a.plan && !(a.counts && a.counts.total) && !(a.today && a.today.messages);
/** The desktop app checks usage every few minutes while signed in, so a recent check means it is in use there. */
const desktopActive = (a) => !!(a.desktopLastSeen && Date.now() - a.desktopLastSeen < 30 * 60 * 1000);
const claudeState = (a) => (a.counts.working ? 'working' : a.counts.idle ? 'idle' : desktopActive(a) ? 'desktop' : 'off');
const agState = (g) => (!g.appRunning ? 'off' : g.counts.working ? 'working' : 'idle');

// ---------- tooltip & toast ----------
const tip = $('#tooltip');
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
  if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
const hideTip = () => (tip.hidden = true);
function tipRows(title, rows) {
  return `<div class="tt-h">${esc(title)}</div>` + rows.map((r) => `<div class="tt-r"><span>${r.color ? `<i class="chip" style="background:${r.color};width:8px;height:8px"></i>` : ''}${esc(r.name)}</span><b class="num">${esc(r.value)}</b></div>`).join('');
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1800);
}

// ---------- charts (hand-rolled SVG, one y-axis) ----------
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function roundedTopBar(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Grouped bar chart. series: [{name, color, values[]}], categories: [label] */
function barChart(el, { categories, series, height = 160, yFmt = fmt, tickEvery = 1, tipTitle = (i) => categories[i] }) {
  const W = Math.max(280, el.clientWidth || 600), H = height, L = 44, R = 8, T = 8, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const max = niceMax(Math.max(4, ...series.flatMap((s) => s.values)));
  const band = iw / categories.length;
  const groupW = Math.min(band * 0.72, 18 * series.length + 2 * (series.length - 1));
  const bw = (groupW - 2 * (series.length - 1)) / series.length;
  const y = (v) => T + ih - (v / max) * ih;
  let g = '<g class="grid">';
  for (let i = 0; i <= 4; i++) g += `<line x1="${L}" x2="${W - R}" y1="${y((max / 4) * i)}" y2="${y((max / 4) * i)}"/>`;
  g += '</g><g class="axis">';
  for (let i = 0; i <= 4; i++) g += `<text x="${L - 6}" y="${y((max / 4) * i) + 4}" text-anchor="end">${yFmt((max / 4) * i)}</text>`;
  categories.forEach((c, i) => {
    if ((categories.length - 1 - i) % tickEvery === 0) g += `<text x="${L + band * i + band / 2}" y="${H - 6}" text-anchor="middle">${esc(c)}</text>`;
  });
  g += '</g>';
  let marks = '';
  let hits = '';
  categories.forEach((_, i) => {
    const gx = L + band * i + (band - groupW) / 2;
    series.forEach((s, j) => {
      const v = s.values[i] || 0;
      marks += `<path class="mark" data-i="${i}" fill="${s.color}" d="${roundedTopBar(gx + j * (bw + 2), y(v), bw, T + ih - y(v), 4)}"/>`;
    });
    hits += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ih}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${g}<line x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}" stroke="var(--border)"/>${marks}${hits}</svg>`;
  el.querySelectorAll('.hit').forEach((h) => {
    const i = Number(h.dataset.i);
    h.addEventListener('mousemove', (e) => {
      el.querySelectorAll('.mark').forEach((m) => m.classList.toggle('hover', Number(m.dataset.i) === i));
      showTip(e, tipRows(tipTitle(i), series.map((s) => ({ name: s.name, value: yFmt(s.values[i] || 0), color: s.color }))));
    });
    h.addEventListener('mouseleave', () => {
      el.querySelectorAll('.mark.hover').forEach((m) => m.classList.remove('hover'));
      hideTip();
    });
  });
}

/** Line chart over time (ms), y fixed 0..100 (%). series: [{name, color, dash, points:[{t,v}]}] */
function percentLineChart(el, { series, from, to, height = 120 }) {
  const W = Math.max(280, el.clientWidth || 600), H = height, L = 36, R = 8, T = 8, B = 20;
  const iw = W - L - R, ih = H - T - B;
  const x = (tm) => L + ((tm - from) / (to - from)) * iw;
  const y = (v) => T + ih - (Math.min(100, Math.max(0, v)) / 100) * ih;
  let g = '<g class="grid">';
  for (const v of [0, 50, 100]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
  g += '</g><g class="axis">';
  for (const v of [0, 50, 100]) g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  const dayMs = 86400000;
  for (let tm = new Date(new Date(from).setHours(0, 0, 0, 0)).getTime() + dayMs; tm < to; tm += dayMs * 2) {
    const d = new Date(tm);
    g += `<text x="${x(tm)}" y="${H - 5}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
  }
  g += '</g>';
  let lines = '';
  for (const s of series) {
    const pts = s.points.filter((p) => p.v != null && p.t >= from);
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    lines += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${g}${lines}<line class="cross" x1="0" x2="0" y1="${T}" y2="${T + ih}" stroke="var(--text-muted)" visibility="hidden"/><g class="dots"></g><rect class="hit" x="${L}" y="${T}" width="${iw}" height="${ih}"/></svg>`;
  const svg = el.querySelector('svg');
  const hit = el.querySelector('.hit');
  hit.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const tm = from + ((px - L) / iw) * (to - from);
    const rows = [];
    let dots = '';
    let nearestT = null;
    for (const s of series) {
      let best = null;
      for (const p of s.points) if (p.v != null && p.t <= tm + ((to - from) / iw) * 6 && (!best || Math.abs(p.t - tm) < Math.abs(best.t - tm))) best = p;
      if (!best) continue;
      nearestT = nearestT ?? best.t;
      rows.push({ name: s.name, value: `${best.v}%`, color: s.color });
      dots += `<circle cx="${x(best.t)}" cy="${y(best.v)}" r="4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2"/>`;
    }
    if (!rows.length) return hideTip();
    const cross = el.querySelector('.cross');
    cross.setAttribute('x1', x(nearestT)); cross.setAttribute('x2', x(nearestT)); cross.setAttribute('visibility', 'visible');
    el.querySelector('.dots').innerHTML = dots;
    showTip(e, tipRows(dateTime(nearestT, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), rows));
  });
  hit.addEventListener('mouseleave', () => {
    el.querySelector('.cross').setAttribute('visibility', 'hidden');
    el.querySelector('.dots').innerHTML = '';
    hideTip();
  });
}

// ---------- shared pieces ----------
function bar(pct) {
  if (pct == null) return '<div class="bar"><span style="width:0"></span></div>';
  const [cls] = level(pct);
  return `<div class="bar ${cls}" role="meter" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, pct)}%"></span></div>`;
}
function meter(label, pct, sampledAt) {
  if (pct == null) return `<div class="meter"><div class="row"><span>${esc(label)}</span><b>—</b></div>${bar(null)}</div>`;
  const [, txt] = level(pct);
  return `<div class="meter"><div class="row"><span>${esc(label)}</span><b class="num">${pct}%</b></div>${bar(pct)}
    <div class="row"><span>${esc(txt)}</span><span>${sampledAt ? esc(t('sampled', { when: rel(sampledAt) })) : ''}</span></div></div>`;
}
/** Lowest remaining quota across Antigravity models (what limits you first). */
function lowestQuota(g) {
  const ms = g.quota && g.quota.models;
  if (!ms || !ms.length) return null;
  return ms.reduce((lo, m) => (m.remaining < lo.remaining ? m : lo));
}

// ---------- full view ----------
function lastSeenText(a) {
  if (a.desktopLastSeen) return t('cardLastSeen', { when: `${dateTime(a.desktopLastSeen, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (${rel(a.desktopLastSeen)})` });
  return t('cardNeverSeen');
}

function noDataCard(a, color) {
  return `<article class="card${a.stale ? ' stale' : ''}" data-id="${esc(a.key)}">
    <header class="card-h">
      <div class="acct-title"><i class="chip" style="background:${color}"></i>
        <div style="min-width:0"><h2 class="acct-name">${esc(accountName(a))}</h2><div class="acct-meta">${machineTag(a)} Claude</div></div></div>
      <div class="card-state">${stateTag(claudeState(a))}</div>
    </header>
    <p class="note-box">ℹ ${esc(t('cardNoDataNote'))}</p>
    <p class="note">${esc(lastSeenText(a))}</p>
  </article>`;
}

function claudeCard(a, color) {
  if (noData(a)) return noDataCard(a, color);
  const p = a.profile || {};
  const meta = [p.orgName, p.billingType && p.billingType.replace(/_/g, ' ')].filter(Boolean).join(' · ');
  const sessions = a.sessions.filter((s) => s.state !== 'archived').slice(0, 15);
  return `<article class="card${a.stale ? ' stale' : ''}" data-id="${esc(a.key)}">
    <header class="card-h">
      <div class="acct-title"><i class="chip" style="background:${color}"></i>
        <div style="min-width:0"><h2 class="acct-name">${esc(accountName(a))}</h2><div class="acct-meta">${machineTag(a)} Claude${meta ? ' · ' + esc(meta) : ''}</div></div></div>
      <div class="card-state">${stateTag(claudeState(a))}<span class="badge">${esc(t('workIdleBadge', { w: a.counts.working, i: a.counts.idle }))}</span></div>
    </header>
    <div class="section-label">${esc(t('planUsage'))}</div>
    ${a.plan ? `<div class="meters">${meter(t('window5h'), a.plan.fiveHour, a.plan.sampledAt)}${meter(t('window7d'), a.plan.sevenDay)}</div>
      <div class="chart plan-chart" style="margin-top:10px"></div>
      <div class="legend"><span><i style="background:${color}"></i>${esc(t('legend5h'))}</span><span><i style="background:${color};opacity:.55"></i>${esc(t('legend7d'))}</span></div>`
      : `<p class="empty">${esc(t('noPlan'))}</p>`}
    <div class="section-label">${esc(t('todayTokens', { machine: a.machine }))}</div>
    <div class="stats">
      <div class="stat"><div class="k">${esc(t('tokOut'))}</div><div class="v num">${fmt(a.today.output)}</div></div>
      <div class="stat"><div class="k">${esc(t('tokIn'))}</div><div class="v num">${fmt(a.today.input)}</div></div>
      <div class="stat"><div class="k">${esc(t('tokCacheR'))}</div><div class="v num">${fmt(a.today.cacheRead)}</div></div>
      <div class="stat"><div class="k">${esc(t('tokCacheW'))}</div><div class="v num">${fmt(a.today.cacheWrite)}</div></div>
    </div>
    <div class="note">${esc(t('last5hNote', { out: fmt(a.last5h.output), msgs: a.last5h.messages, today: a.today.messages }))}</div>
    <div class="section-label">${esc(t('hourlyOut'))}</div>
    <div class="chart hourly-chart"></div>
    <div class="section-label">${esc(t('sessions', { n: a.counts.total }))}</div>
    ${sessions.length ? `<ul class="list" data-scroll="${esc(a.key)}">${sessions.map((s) => `<li>
      ${stateTag(s.state)}<span class="t" title="${esc(s.cwd)}">${esc(s.title || s.sessionId.slice(0, 8))}</span>
      <span class="r num" title="${esc(t('sessionTokTitle'))}">${fmt(s.tokens.output)}</span>
      <span class="m">${esc([s.project, shortModel(s.model), s.subagents ? t('subagents', { n: s.subagents }) : null, rel(s.lastActivity)].filter(Boolean).join(' · '))}</span>
    </li>`).join('')}</ul>` : `<p class="empty">${esc(t('noSessions', { machine: a.machine }))}</p>`}
  </article>`;
}

/** Short reset countdown for tight rows: 45m · 3h13m · 7d */
function shortUntil(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / 1440)}d`;
}

/** Models with the same remaining fraction and reset time share one quota pool: show them as one row. */
function quotaPools(models) {
  const pools = new Map();
  for (const m of models) {
    const key = `${m.remaining.toFixed(4)}|${m.resetTime || ''}`;
    if (!pools.has(key)) pools.set(key, { remaining: m.remaining, resetTime: m.resetTime, labels: [] });
    pools.get(key).labels.push(m.label);
  }
  return [...pools.values()]
    .map((p) => ({ ...p, family: [...new Set(p.labels.map((l) => l.replace(/\s*\([^)]*\)\s*$/, '')))] }))
    .sort((a, b) => a.remaining - b.remaining);
}

function quotaBlock(g) {
  const q = g.quota;
  if (q && q.models.length) {
    let html = `<div class="quota-table">${quotaPools(q.models).map((p) => {
      const used = Math.round((1 - p.remaining) * 100);
      return `<div class="q-row" title="${esc(p.labels.join('\n'))}">
        <span class="q-name">${esc(p.family.join(', '))}${p.labels.length > p.family.length ? ` <span class="q-n">×${p.labels.length}</span>` : ''}</span>
        ${bar(used)}<b class="num">${esc(t('quotaLeft', { p: Math.round(p.remaining * 100) }))}</b>
        <span class="q-reset" title="${esc(until(p.resetTime))}">↻ ${esc(shortUntil(p.resetTime))}</span></div>`;
    }).join('')}</div>`;
    if (q.promptCredits) {
      const v = `${fmt(q.promptCredits.available)}${q.promptCredits.monthly ? ' / ' + fmt(q.promptCredits.monthly) : ''}${q.planName ? ' · ' + q.planName : ''}`;
      html += `<div class="note">${esc(t('promptCredits', { v }))}</div>`;
    }
    return html;
  }
  if (!g.quotaEnabled) return `<p class="empty">${esc(t('quotaOff'))}</p>`;
  if (g.quotaError) return `<p class="empty">${esc(t('quotaErr', { e: errText(g.quotaError) }))}</p>`;
  return `<p class="empty">${esc(g.languageServerRunning ? t('quotaPending') : t('quotaNoLs'))}</p>`;
}

function agCard(g) {
  return `<article class="card${g.stale ? ' stale' : ''}" data-id="${esc(g.key)}">
    <header class="card-h">
      <div class="acct-title"><i class="chip" style="background:${AG_COLOR}"></i>
        <div style="min-width:0"><h2 class="acct-name">${esc(g.label)}</h2><div class="acct-meta">${machineTag(g)} Antigravity</div></div></div>
      <div class="card-state">${stateTag(agState(g))}<span class="badge">${esc(g.appRunning ? t('appRunning') : t('appStopped'))}</span></div>
    </header>
    <div class="section-label">${esc(t('quota'))}</div>
    ${quotaBlock(g)}
    <div class="section-label">${esc(t('activity'))}</div>
    <div class="stats">
      <div class="stat"><div class="k">${esc(t('agActive'))}</div><div class="v num">${g.counts.working}</div></div>
      <div class="stat"><div class="k">${esc(t('agToday'))}</div><div class="v num">${g.counts.today}</div></div>
      <div class="stat"><div class="k">${esc(t('agStepsToday'))}</div><div class="v num">${fmt(g.counts.stepsToday)}</div></div>
      <div class="stat"><div class="k">${esc(t('agTotal'))}</div><div class="v num">${g.counts.total}</div></div>
    </div>
    <div class="section-label">${esc(t('agDaily'))}</div>
    <div class="chart ag-chart"></div>
    <div class="section-label">${esc(t('conversations'))}</div>
    ${g.error ? `<p class="alert">${esc(errText(g.error))}</p>` : ''}
    <ul class="list" data-scroll="${esc(g.key)}">${g.conversations.slice(0, 15).map((c) => `<li>
      ${stateTag(c.state)}<span class="t">${esc(c.title || t('untitled'))}</span><span class="r num">${esc(t('stepsN', { n: fmt(c.steps) }))}</span>
      <span class="m">${esc([c.project, c.agent, rel(c.lastActivity)].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>
  </article>`;
}

function renderFull(claude, antigravity) {
  const working = claude.reduce((n, a) => n + a.counts.working, 0) + antigravity.reduce((n, g) => n + g.counts.working, 0);
  const idle = claude.reduce((n, a) => n + a.counts.idle, 0);
  const maxFh = Math.max(-1, ...claude.map((a) => (a.plan && a.plan.fiveHour) ?? -1));
  const maxSd = Math.max(-1, ...claude.map((a) => (a.plan && a.plan.sevenDay) ?? -1));
  const tiles = [[t('tileWorking'), working, t('tileWorkingSub', { n: idle })]];
  if (claude.length) {
    tiles.push(
      [t('tileClaudeOut'), fmt(claude.reduce((n, a) => n + a.today.output, 0)), t('tileClaudeOutSub', { msgs: claude.reduce((n, a) => n + a.today.messages, 0), n: claude.length })],
      [t('tileMax5h'), maxFh >= 0 ? `${maxFh}%` : '—', t('tileMaxSub')],
      [t('tileMax7d'), maxSd >= 0 ? `${maxSd}%` : '—', t('tileMaxSub')]
    );
  }
  if (antigravity.length) {
    tiles.push([t('tileAg'), antigravity.reduce((n, g) => n + g.counts.today, 0), t('tileAgSub', { steps: fmt(antigravity.reduce((n, g) => n + g.counts.stepsToday, 0)) })]);
  }
  $('#tiles').innerHTML = tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v num">${esc(v)}</div><div class="d">${esc(d)}</div></div>`).join('');

  $('#accounts').innerHTML = claude.map((a, i) => claudeCard(a, SERIES[i % SERIES.length])).join('') + antigravity.map(agCard).join('');

  const now = Date.now();
  claude.forEach((a, i) => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(a.key)}"]`);
    const color = SERIES[i % SERIES.length];
    if (noData(a)) return;
    barChart(card.querySelector('.hourly-chart'), {
      categories: a.hourly.map((h) => `${new Date(h.t).getHours()}`),
      series: [{ name: t('outTokens'), color, values: a.hourly.map((h) => h.output) }],
      height: 110,
      tickEvery: 3,
      tipTitle: (k) => dateTime(a.hourly[k].t, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    });
    const pc = card.querySelector('.plan-chart');
    if (pc) {
      percentLineChart(pc, {
        from: now - 14 * 86400000,
        to: now,
        series: [
          { name: t('window5h'), color, points: a.plan.history.map((h) => ({ t: h.t, v: h.fiveHour })) },
          { name: t('window7d'), color, dash: true, points: a.plan.history.map((h) => ({ t: h.t, v: h.sevenDay })) },
        ],
      });
    }
  });
  antigravity.forEach((g) => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(g.key)}"]`);
    barChart(card.querySelector('.ag-chart'), {
      categories: g.daily.map((d) => d.date.slice(5).replace('-', '/')),
      series: [{ name: t('agSteps'), color: AG_COLOR, values: g.daily.map((d) => d.steps) }],
      height: 110,
      tickEvery: 3,
      tipTitle: (k) => `${g.daily[k].date} · ${t('agConvCount', { n: g.daily[k].conversations })}`,
    });
  });

  // cross-account daily comparison
  $('#daily-section').hidden = !claude.length;
  if (!claude.length) return;
  const days = claude[0].daily.map((d) => d.date);
  const series = claude.map((a, i) => ({ name: a.remote ? `${accountName(a)} @${a.machine}` : accountName(a), color: SERIES[i % SERIES.length], values: a.daily.map((d) => d.output) }));
  $('#daily-legend').innerHTML = series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') : '';
  barChart($('#daily-chart'), { categories: days.map((d) => d.slice(5).replace('-', '/')), series, height: 200, tipTitle: (k) => days[k] });
  $('#daily-table').innerHTML = `<table><thead><tr><th>${esc(t('date'))}</th>${series.map((x) => `<th>${esc(x.name)}</th>`).join('')}</tr></thead><tbody>${days
    .map((d, k) => `<tr><td>${d}</td>${claude.map((a) => `<td class="num">${a.daily[k].output.toLocaleString(t.lang)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

// ---------- compact view: one row per account ----------
function renderCompact(claude, antigravity) {
  const rows = [];
  claude.forEach((a, i) => {
    const color = SERIES[i % SERIES.length];
    const p = a.plan || {};
    if (noData(a)) {
      rows.push(`<div class="crow${a.stale ? ' stale' : ''}">
      <div class="c-name"><i class="chip" style="background:${color}"></i><div class="c-text"><b>${esc(accountName(a))}</b><span>${machineTag(a)} Claude</span></div></div>
      <div class="c-state">${stateTag(claudeState(a))}</div>
      <div class="c-wide c-sub" title="${esc(t('cardNoDataNote'))}">${esc(t('compactNoData', { when: a.desktopLastSeen ? rel(a.desktopLastSeen) : '—' }))}</div>
    </div>`);
      return;
    }
    rows.push(`<div class="crow${a.stale ? ' stale' : ''}">
      <div class="c-name"><i class="chip" style="background:${color}"></i><div class="c-text"><b>${esc(accountName(a))}</b><span>${machineTag(a)} Claude</span></div></div>
      <div class="c-state">${stateTag(claudeState(a))}<span class="c-sub">${esc(t('workIdleBadge', { w: a.counts.working, i: a.counts.idle }))}</span></div>
      <div class="c-meter"><span class="c-k">5h</span>${bar(p.fiveHour)}<b class="num">${p.fiveHour != null ? p.fiveHour + '%' : '—'}</b></div>
      <div class="c-meter"><span class="c-k">7d</span>${bar(p.sevenDay)}<b class="num">${p.sevenDay != null ? p.sevenDay + '%' : '—'}</b></div>
      <div class="c-num"><span class="c-k">${esc(t('tokOut'))}</span><b class="num">${fmt(a.today.output)}</b></div>
    </div>`);
  });
  antigravity.forEach((g) => {
    const lo = lowestQuota(g);
    const used = lo ? Math.round((1 - lo.remaining) * 100) : null;
    rows.push(`<div class="crow${g.stale ? ' stale' : ''}">
      <div class="c-name"><i class="chip" style="background:${AG_COLOR}"></i><div class="c-text"><b>${esc(g.label)}</b><span>${machineTag(g)} Antigravity</span></div></div>
      <div class="c-state">${stateTag(agState(g))}<span class="c-sub">${esc(t('agActive'))} ${g.counts.working}</span></div>
      <div class="c-meter wide" title="${esc(lo ? lo.label : '')}"><span class="c-k">${esc(t('lowestQuota'))}</span>${bar(used)}<b class="num">${lo ? esc(t('quotaLeft', { p: Math.round(lo.remaining * 100) })) : '—'}</b></div>
      <div class="c-num"><span class="c-k">${esc(t('agToday'))}</span><b class="num">${g.counts.today}</b></div>
    </div>`);
  });
  $('#compact').innerHTML = rows.length ? `<div class="card compact-list">${rows.join('')}</div>` : '';
}

// ---------- empty / missing sources ----------
function renderEmpty(claude, antigravity) {
  const src = snapshot.sources;
  const notes = [];
  if (!claude.length && !antigravity.length) {
    notes.push(`<div class="card empty-card"><h2>${esc(t('noneTitle'))}</h2><p>${esc(t('noneBody'))}</p></div>`);
  }
  if (src) {
    if (src.claude.enabled && !claude.length) notes.push(`<p class="note">ℹ ${esc(t('claudeMissing'))} — ${esc(t('claudeMissingBody', { paths: src.claude.paths.join(', ') }))}</p>`);
    if (src.antigravity.enabled && !antigravity.length) notes.push(`<p class="note">ℹ ${esc(t('agMissing'))} — ${esc(t('agMissingBody', { paths: src.antigravity.paths.join(', ') }))}</p>`);
  }
  $('#empty').innerHTML = notes.join('');
}

function render() {
  if (!snapshot || !prefs) return;
  const { claude, antigravity } = snapshot;
  updatedLine();
  $('#errors').innerHTML = (snapshot.errors || []).map((e) => `<div class="alert">${esc(errText(e))}</div>`).join('');
  renderEmpty(claude, antigravity);

  // keep list scroll positions across re-renders
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((l) => (scrolls[l.dataset.scroll] = l.scrollTop));
  if (prefs.value.view === 'compact') renderCompact(claude, antigravity);
  else renderFull(claude, antigravity);
  document.querySelectorAll('[data-scroll]').forEach((l) => (l.scrollTop = scrolls[l.dataset.scroll] || 0));
}

function updatedLine() {
  if (!snapshot || !prefs) return;
  const parts = [t('updated', { when: rel(snapshot.at) }), t('every', { n: prefs.value.refreshSeconds })];
  if (snapshot.share && snapshot.share.running) parts.push(t('sharing', { port: snapshot.share.port }));
  const tm = snapshot.timings || {};
  if (tm.claude != null) parts.push(t('readCost', { s: ((tm.claude + tm.antigravity) / 1000).toFixed(1) }));
  const machines = (snapshot.machines || []).length > 1
    ? '   ' + snapshot.machines.map((m) => `${m.ok ? '●' : '○'} ${m.name}${m.local ? ` (${t('thisMachine')})` : ''}`).join('  ')
    : '';
  $('#updated').textContent = parts.join(' · ') + machines;
  $('#updated').title = tm.claude != null ? `Claude ${tm.claude} ms · Antigravity ${tm.antigravity} ms` : '';
}

// ---------- view mode & prefs ----------
function applyPrefs(p) {
  prefs = p;
  t = I18N.create(p.lang);
  applyStaticText();
  document.body.dataset.view = p.value.view;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === p.value.view)));
  $('#btn-pin').setAttribute('aria-pressed', String(!!p.value.alwaysOnTop));
  render();
}

document.querySelectorAll('[data-view]').forEach((b) =>
  b.addEventListener('click', async () => applyPrefs(await dashboard.patchSettings({ view: b.dataset.view })))
);

// ---------- settings dialog ----------
let draftRemotes = [];

function renderRemotes() {
  $('#remote-list').innerHTML = draftRemotes.length
    ? draftRemotes.map((r, i) => `<li><span><b>${esc(r.name || r.urls[0])}</b> <span class="hint mono">${esc(r.urls.join(', '))}</span></span>
        <button type="button" class="btn small" data-remove="${i}">${esc(t('sRemoteRemove'))}</button></li>`).join('')
    : `<li class="hint">${esc(t('sRemoteNone'))}</li>`;
}
$('#remote-list').addEventListener('click', (e) => {
  const i = e.target.dataset && e.target.dataset.remove;
  if (i == null) return;
  draftRemotes.splice(Number(i), 1);
  renderRemotes();
});
async function addRemote() {
  const input = $('#remote-input');
  const parsed = await dashboard.parseRemote(input.value);
  const err = $('#remote-error');
  if (!parsed) {
    err.textContent = t('sRemoteBad');
    err.hidden = false;
    return;
  }
  err.hidden = true;
  draftRemotes = draftRemotes.filter((r) => r.token !== parsed.token);
  draftRemotes.push(parsed);
  input.value = '';
  renderRemotes();
}
$('#remote-add').addEventListener('click', addRemote);
$('#remote-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // add the remote instead of submitting the whole dialog
    addRemote();
  }
});

function shareStatusText(p) {
  if (p.share.running) {
    const urls = (p.share.addresses || []).map((a) => `http://${a}:${p.share.port}`).join(', ');
    return t('sShareOn', { urls });
  }
  return p.share.error ? t('sShareErr', { e: errText(p.share.error) }) : t('sShareOff');
}

function fillShare(p) {
  $('#share-status').textContent = shareStatusText(p);
  $('#share-code').value = p.code || '';
  $('#share-box').hidden = !$('#settings-form').shareEnabled.checked;
}

// ---------- settings: accounts (rename / show-hide what this computer detected) ----------
// What the user has typed / toggled in the account rows, kept across re-renders while the dialog is open.
let accDraft = new Map();

function accountRows() {
  const all = (snapshot && snapshot.allAccounts) || { claude: snapshot ? snapshot.claude : [], antigravity: snapshot ? snapshot.antigravity : [] };
  return { claude: all.claude.filter((a) => !a.remote), antigravity: all.antigravity.filter((g) => !g.remote) };
}

function accountRowHtml(kind, a, p) {
  const key = `${kind}|${a.id}`;
  const d = accDraft.get(key) || {};
  const conf = kind === 'claude' ? p.value.claude : p.value.antigravity;
  const shown = d.show ?? !conf.hidden.includes(a.id);
  const name = d.name ?? (conf.labels[a.id] || '');
  const detected = kind === 'antigravity' ? a.label : (a.profile && a.profile.email) || t('claudeAccountN', { n: a.ordinal });
  const extra = kind === 'claude' && a.desktopLastSeen ? ` · ${t('cardLastSeen', { when: rel(a.desktopLastSeen) })}` : '';
  return `<li class="acc-row" data-key="${esc(key)}" data-kind="${kind}" data-id="${esc(a.id)}">
      <input type="checkbox" class="acc-show" title="${esc(t('sAccShow'))}" aria-label="${esc(t('sAccShow'))}" ${shown ? 'checked' : ''} />
      <div class="acc-main">
        <input type="text" class="acc-name" value="${esc(name)}" placeholder="${esc(detected)}" />
        <span class="hint">${esc(detected)} · ${esc(t('sAccDetected'))}${esc(extra)}</span>
      </div>
    </li>`;
}

function renderAccounts(p) {
  const rows = accountRows();
  $('#acc-claude').innerHTML = rows.claude.map((a) => accountRowHtml('claude', a, p)).join('') || `<li class="hint">${esc(t('claudeMissing'))}</li>`;
  $('#acc-ag').innerHTML = rows.antigravity.map((g) => accountRowHtml('antigravity', g, p)).join('') || `<li class="hint">${esc(t('agMissing'))}</li>`;
  $('#acc-remote-note').hidden = !((snapshot && snapshot.machines) || []).some((m) => !m.local);
}

// remember edits so a refresh while the dialog is open doesn't wipe them
for (const sel of ['#acc-claude', '#acc-ag']) {
  $(sel).addEventListener('input', (e) => {
    const row = e.target.closest('.acc-row');
    if (!row) return;
    const d = accDraft.get(row.dataset.key) || {};
    if (e.target.classList.contains('acc-name')) d.name = e.target.value;
    if (e.target.classList.contains('acc-show')) d.show = e.target.checked;
    accDraft.set(row.dataset.key, d);
  });
}

/** Names and visibility from the account rows, merged into fresh settings on save. */
function collectAccountEdits(value) {
  const claude = { labels: { ...value.claude.labels }, hidden: [...value.claude.hidden] };
  const ag = { labels: { ...value.antigravity.labels }, hidden: [...value.antigravity.hidden] };
  document.querySelectorAll('.acc-row').forEach((row) => {
    const id = row.dataset.id;
    const name = row.querySelector('.acc-name').value.trim();
    const target = row.dataset.kind === 'antigravity' ? ag : claude;
    target.hidden = target.hidden.filter((h) => h !== id);
    if (!row.querySelector('.acc-show').checked) target.hidden.push(id);
    if (name) target.labels[id] = name;
    else delete target.labels[id];
  });
  return { claude, ag };
}

async function openSettings() {
  const p = await dashboard.getSettings();
  applyPrefs(p);
  const v = p.value;
  const f = $('#settings-form');
  $('#lang-select').innerHTML = [`<option value="auto">${esc(t('langAuto'))}</option>`, ...I18N.LANGS.map((l) => `<option value="${l.code}">${esc(l.name)}</option>`)].join('');
  f.language.value = v.language;
  f.refreshSeconds.value = v.refreshSeconds;
  f.machineName.value = v.machineName;
  f.machineName.placeholder = p.hostname;
  f.closeToTray.checked = v.closeToTray;
  f.claudeEnabled.checked = v.claude.enabled;
  f.agEnabled.checked = v.antigravity.enabled;
  f.quotaProbe.checked = v.antigravity.quotaProbe;
  f.agDataDirs.value = v.antigravity.dataDirs.join('\n');
  const home = p.platform === 'win32' ? 'C:\\Users\\you' : '/Users/you';
  const sep = p.platform === 'win32' ? '\\' : '/';
  $('#ag-dirs').placeholder = `${home}${sep}.gemini${sep}antigravity`;
  f.shareEnabled.checked = v.share.enabled;
  f.sharePort.value = v.share.port;
  $('#firewall-hint').textContent = p.platform === 'darwin' ? t('sFirewallMac') : p.platform === 'win32' ? t('sFirewallWin') : '';
  fillShare(p);

  accDraft = new Map();
  renderAccounts(p);

  draftRemotes = v.remotes.map((r) => ({ ...r, urls: [...r.urls] }));
  renderRemotes();
  $('#remote-input').value = '';
  $('#remote-error').hidden = true;
  $('#settings-file').textContent = t('sFile', { file: p.file });
  $('#settings').showModal();
}

$('#settings-form').shareEnabled.addEventListener('change', (e) => ($('#share-box').hidden = !e.target.checked));
$('#share-copy').addEventListener('click', async () => {
  if (!$('#share-code').value) return;
  await dashboard.copy($('#share-code').value);
  toast(t('sCopied'));
});
$('#share-regen').addEventListener('click', async () => {
  const p = await dashboard.getSettings();
  const token = await dashboard.newShareToken();
  const saved = await dashboard.saveSettings({ ...p.value, share: { ...p.value.share, token } });
  fillShare(saved);
});
$('#settings-cancel').addEventListener('click', () => $('#settings').close());

// Enter anywhere (and the Save button) submits = save. Escape / Cancel close without saving.
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { value } = await dashboard.getSettings();
  const f = $('#settings-form');
  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const acc = collectAccountEdits(value);
  // Something still typed in the "add computer" box counts as added.
  if ($('#remote-input').value.trim()) {
    const parsed = await dashboard.parseRemote($('#remote-input').value);
    if (parsed) draftRemotes.push(parsed);
  }
  const saved = await dashboard.saveSettings({
    ...value,
    language: f.language.value,
    refreshSeconds: Math.max(3, Math.min(600, Number(f.refreshSeconds.value) || 10)),
    machineName: f.machineName.value.trim(),
    closeToTray: f.closeToTray.checked,
    share: { ...value.share, enabled: f.shareEnabled.checked, port: Math.min(65535, Math.max(1024, Number(f.sharePort.value) || 47821)) },
    remotes: draftRemotes,
    claude: { ...value.claude, enabled: f.claudeEnabled.checked, labels: acc.claude.labels, hidden: acc.claude.hidden },
    antigravity: { ...value.antigravity, enabled: f.agEnabled.checked, quotaProbe: f.quotaProbe.checked, dataDirs: lines(f.agDataDirs.value), labels: acc.ag.labels, hidden: acc.ag.hidden },
  });
  $('#settings').close();
  applyPrefs(saved);
  toast(t('sSaved'));
});

// ---------- wiring ----------
$('#btn-refresh').addEventListener('click', () => dashboard.refresh());
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-pin').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  applyPrefs(await dashboard.patchSettings({ alwaysOnTop: on }));
});
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});
setInterval(updatedLine, 5000);

dashboard.onSnapshot((s) => {
  snapshot = s;
  render();
  if ($('#settings').open && prefs) dashboard.getSettings().then(renderAccounts);
});
dashboard.getSettings().then(applyPrefs);
