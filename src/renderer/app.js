/* global dashboard */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-4)'];
const AG_COLOR = 'var(--series-3)';

let snapshot = null;
let settings = null;

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
  if (s < 0) return '剛剛';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}
function until(ts) {
  if (!ts) return '';
  const m = Math.round((ts - Date.now()) / 60000);
  if (m <= 0) return '即將重置';
  if (m < 60) return `${m} 分鐘後重置`;
  if (m < 1440) return `${Math.floor(m / 60)} 小時 ${m % 60} 分後重置`;
  return `${Math.floor(m / 1440)} 天後重置`;
}
const STATE_LABEL = { working: '工作中', idle: '閒置', waiting: '等待輸入', error: '錯誤', ended: '已結束', archived: '已封存', off: '未啟動' };
const stateTag = (st) => `<span class="state ${st}"><i></i>${STATE_LABEL[st] || st}</span>`;
function level(pct) {
  if (pct >= 95) return ['critical', '⛔ 將達上限'];
  if (pct >= 80) return ['serious', '▲ 偏高'];
  if (pct >= 60) return ['warning', '● 注意'];
  return ['good', '✓ 正常'];
}
const machineTag = (x) => `<span class="machine${x.remote ? ' remote' : ''}${x.stale ? ' stale' : ''}" title="${x.stale ? '目前連不到，顯示的是 ' + rel(x.collectedAt) + ' 的資料' : '資料來源電腦'}">💻 ${esc(x.machine)}${x.stale ? ' · 離線' : ''}</span> `;
const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '');

// ---------- tooltip ----------
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
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
  }
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
      const x = gx + j * (bw + 2);
      marks += `<path class="mark" data-i="${i}" fill="${s.color}" d="${roundedTopBar(x, y(v), bw, T + ih - y(v), 4)}"/>`;
    });
    hits += `<rect class="hit" data-i="${i}" x="${L + band * i}" y="${T}" width="${band}" height="${ih}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">${g}<line x1="${L}" x2="${W - R}" y1="${T + ih}" y2="${T + ih}" stroke="var(--border)"/>${marks}${hits}</svg>`;
  el.querySelectorAll('.hit').forEach((h) => {
    const i = Number(h.dataset.i);
    h.addEventListener('mousemove', (e) => {
      el.querySelectorAll(`.mark`).forEach((m) => m.classList.toggle('hover', Number(m.dataset.i) === i));
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
  const x = (t) => L + ((t - from) / (to - from)) * iw;
  const y = (v) => T + ih - (Math.min(100, Math.max(0, v)) / 100) * ih;
  let g = '<g class="grid">';
  for (const v of [0, 50, 100]) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
  g += '</g><g class="axis">';
  for (const v of [0, 50, 100]) g += `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`;
  const dayMs = 86400000;
  for (let t = new Date(new Date(from).setHours(0, 0, 0, 0)).getTime() + dayMs; t < to; t += dayMs * 2) {
    const d = new Date(t);
    g += `<text x="${x(t)}" y="${H - 5}" text-anchor="middle">${d.getMonth() + 1}/${d.getDate()}</text>`;
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
    const t = from + ((px - L) / iw) * (to - from);
    const rows = [];
    let dots = '';
    let nearestT = null;
    for (const s of series) {
      let best = null;
      for (const p of s.points) if (p.v != null && p.t <= t + (to - from) / iw * 6 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
      if (!best) continue;
      nearestT = nearestT ?? best.t;
      rows.push({ name: s.name, value: `${best.v}%`, color: s.color });
      dots += `<circle cx="${x(best.t)}" cy="${y(best.v)}" r="4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2"/>`;
    }
    if (!rows.length) return hideTip();
    const cross = el.querySelector('.cross');
    cross.setAttribute('x1', x(nearestT)); cross.setAttribute('x2', x(nearestT)); cross.setAttribute('visibility', 'visible');
    el.querySelector('.dots').innerHTML = dots;
    showTip(e, tipRows(new Date(nearestT).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }), rows));
  });
  hit.addEventListener('mouseleave', () => {
    el.querySelector('.cross').setAttribute('visibility', 'hidden');
    el.querySelector('.dots').innerHTML = '';
    hideTip();
  });
}

// ---------- rendering ----------
function meter(label, pct, sampledAt) {
  if (pct == null) return `<div class="meter"><div class="row"><span>${label}</span><b>—</b></div><div class="bar"><span style="width:0"></span></div></div>`;
  const [cls, txt] = level(pct);
  return `<div class="meter"><div class="row"><span>${label}</span><b class="num">${pct}%</b></div>
    <div class="bar ${cls}" role="meter" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.min(100, pct)}%"></span></div>
    <div class="row"><span>${txt}</span><span>${sampledAt ? '取樣於 ' + rel(sampledAt) : ''}</span></div></div>`;
}

function claudeCard(a, color) {
  const p = a.profile || {};
  const st = a.counts.working ? 'working' : a.counts.idle ? 'idle' : 'off';
  const meta = [p.orgName, p.billingType && p.billingType.replace(/_/g, ' '), a.orgUuid && `org ${a.orgUuid.slice(0, 8)}`].filter(Boolean).join(' · ');
  const sessions = a.sessions.filter((s) => s.state !== 'archived').slice(0, 15);
  return `<article class="card${a.stale ? ' stale' : ''}" data-id="${esc(a.key)}">
    <header class="card-h">
      <div class="acct-title"><i class="chip" style="background:${color}"></i>
        <div style="min-width:0"><h2 class="acct-name">${esc(a.label)}</h2><div class="acct-meta">${machineTag(a)}Claude · ${esc(meta)}</div></div></div>
      <div style="display:flex;gap:8px;align-items:center">${stateTag(st)}<span class="badge">${a.counts.working} 工作 / ${a.counts.idle} 閒置</span></div>
    </header>
    <div class="section-label">方案用量</div>
    ${a.plan ? `<div class="meters">${meter('5 小時視窗', a.plan.fiveHour, a.plan.sampledAt)}${meter('7 天視窗', a.plan.sevenDay)}</div>
      <div class="chart plan-chart" style="margin-top:10px"></div>
      <div class="legend"><span><i style="background:${color}"></i>5 小時 %（實線）</span><span><i style="background:${color};opacity:.55"></i>7 天 %（虛線）</span></div>`
      : '<p class="empty">尚無方案用量資料 — 在 Claude 桌面版切換到此帳號並開啟用量面板後會自動記錄。</p>'}
    <div class="section-label">今日 tokens（${esc(a.machine)} 的 Claude Code 紀錄）</div>
    <div class="stats">
      <div class="stat"><div class="k">輸出</div><div class="v num">${fmt(a.today.output)}</div></div>
      <div class="stat"><div class="k">輸入</div><div class="v num">${fmt(a.today.input)}</div></div>
      <div class="stat"><div class="k">快取讀取</div><div class="v num">${fmt(a.today.cacheRead)}</div></div>
      <div class="stat"><div class="k">快取寫入</div><div class="v num">${fmt(a.today.cacheWrite)}</div></div>
    </div>
    <div class="note">近 5 小時：輸出 ${fmt(a.last5h.output)} · ${a.last5h.messages} 次回應　今日 ${a.today.messages} 次回應</div>
    <div class="section-label">近 24 小時輸出 tokens</div>
    <div class="chart hourly-chart"></div>
    <div class="section-label">Sessions（${a.counts.total}）</div>
    ${sessions.length ? `<ul class="list" data-scroll="${esc(a.key)}">${sessions.map((s) => `<li>
      ${stateTag(s.state)}<span class="t" title="${esc(s.cwd)}">${esc(s.title || s.sessionId.slice(0, 8))}</span>
      <span class="r num" title="累計輸出 tokens">${fmt(s.tokens.output)}</span>
      <span class="m">${esc([s.project, shortModel(s.model), s.subagents ? `${s.subagents} 個子代理` : null, rel(s.lastActivity)].filter(Boolean).join(' · '))}</span>
    </li>`).join('')}</ul>` : `<p class="empty">「${esc(a.machine)}」上沒有此帳號的 session 紀錄。</p>`}
  </article>`;
}

function agCard(g) {
  const st = !g.appRunning ? 'off' : g.counts.working ? 'working' : 'idle';
  const q = g.quota;
  let quotaHtml;
  if (q && q.models.length) {
    quotaHtml = `<div class="meters">${q.models.map((m) => {
      const used = Math.round((1 - m.remaining) * 100);
      const [cls] = level(used);
      return `<div class="meter"><div class="row"><span title="${esc(m.label)}">${esc(m.label)}</span><b class="num">剩 ${Math.round(m.remaining * 100)}%</b></div>
        <div class="bar ${cls}"><span style="width:${used}%"></span></div><div class="row"><span>已用 ${used}%</span><span>${until(m.resetTime)}</span></div></div>`;
    }).join('')}</div>`;
    if (q.promptCredits) quotaHtml += `<div class="note">Prompt credits：${fmt(q.promptCredits.available)}${q.promptCredits.monthly ? ' / ' + fmt(q.promptCredits.monthly) : ''}${q.planName ? ' · ' + esc(q.planName) : ''}</div>`;
  } else if (!g.quotaEnabled) {
    quotaHtml = '<p class="empty">模型配額讀取未開啟（設定 → Antigravity → 讀取模型配額）。</p>';
  } else if (g.quotaError) {
    quotaHtml = `<p class="empty">無法讀取配額：${esc(g.quotaError)}</p>`;
  } else {
    quotaHtml = `<p class="empty">${g.languageServerRunning ? '讀取中或無配額資訊。' : 'Antigravity 未執行，無法讀取配額。'}</p>`;
  }
  return `<article class="card${g.stale ? ' stale' : ''}" data-id="${esc(g.key)}">
    <header class="card-h">
      <div class="acct-title"><i class="chip" style="background:${AG_COLOR}"></i>
        <div style="min-width:0"><h2 class="acct-name">${esc(g.label)}</h2><div class="acct-meta">${machineTag(g)}Antigravity · ${esc(g.dataDir)}</div></div></div>
      <div style="display:flex;gap:8px;align-items:center">${stateTag(st)}<span class="badge">${g.appRunning ? 'App 執行中' : 'App 未啟動'}</span></div>
    </header>
    <div class="section-label">模型配額</div>
    ${quotaHtml}
    <div class="section-label">活動</div>
    <div class="stats">
      <div class="stat"><div class="k">進行中</div><div class="v num">${g.counts.working}</div></div>
      <div class="stat"><div class="k">今日對話</div><div class="v num">${g.counts.today}</div></div>
      <div class="stat"><div class="k">今日步驟</div><div class="v num">${fmt(g.counts.stepsToday)}</div></div>
      <div class="stat"><div class="k">對話總數</div><div class="v num">${g.counts.total}</div></div>
    </div>
    <div class="section-label">近 14 天 agent 步驟數（依對話最後活動日）</div>
    <div class="chart ag-chart"></div>
    <div class="section-label">對話</div>
    ${g.error ? `<p class="alert">${esc(g.error)}</p>` : ''}
    <ul class="list" data-scroll="${esc(g.key)}">${g.conversations.slice(0, 15).map((c) => `<li>
      ${stateTag(c.state)}<span class="t">${esc(c.title)}</span><span class="r num">${fmt(c.steps)} 步</span>
      <span class="m">${esc([c.project, c.agent, rel(c.lastActivity)].filter(Boolean).join(' · '))}</span></li>`).join('')}</ul>
  </article>`;
}

function render() {
  if (!snapshot) return;
  const { claude, antigravity } = snapshot;
  updatedLine();

  // tiles
  const working = claude.reduce((n, a) => n + a.counts.working, 0) + antigravity.reduce((n, g) => n + g.counts.working, 0);
  const idle = claude.reduce((n, a) => n + a.counts.idle, 0);
  const outToday = claude.reduce((n, a) => n + a.today.output, 0);
  const msgsToday = claude.reduce((n, a) => n + a.today.messages, 0);
  const maxFh = Math.max(-1, ...claude.map((a) => (a.plan && a.plan.fiveHour) ?? -1));
  const maxSd = Math.max(-1, ...claude.map((a) => (a.plan && a.plan.sevenDay) ?? -1));
  $('#tiles').innerHTML = [
    ['工作中的 Agent', working, `${idle} 個 Claude session 閒置`],
    ['Claude 今日輸出', fmt(outToday), `${msgsToday} 次回應 · ${claude.length} 個帳號`],
    ['最高 5 小時用量', maxFh >= 0 ? `${maxFh}%` : '—', '各帳號中最高者'],
    ['最高 7 天用量', maxSd >= 0 ? `${maxSd}%` : '—', '各帳號中最高者'],
    ['Antigravity 今日', antigravity.reduce((n, g) => n + g.counts.today, 0), `對話 · ${fmt(antigravity.reduce((n, g) => n + g.counts.stepsToday, 0))} 步驟`],
  ].map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v num">${v}</div><div class="d">${d}</div></div>`).join('');

  $('#errors').innerHTML = (snapshot.errors || []).map((e) => `<div class="alert">${esc(e)}</div>`).join('');

  // keep list scroll positions across re-renders
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((l) => (scrolls[l.dataset.scroll] = l.scrollTop));

  $('#accounts').innerHTML = claude.map((a, i) => claudeCard(a, SERIES[i % SERIES.length])).join('') + antigravity.map(agCard).join('');

  document.querySelectorAll('[data-scroll]').forEach((l) => (l.scrollTop = scrolls[l.dataset.scroll] || 0));

  const now = Date.now();
  claude.forEach((a, i) => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(a.key)}"]`);
    const color = SERIES[i % SERIES.length];
    const hourly = card.querySelector('.hourly-chart');
    barChart(hourly, {
      categories: a.hourly.map((h) => `${new Date(h.t).getHours()}`),
      series: [{ name: '輸出 tokens', color, values: a.hourly.map((h) => h.output) }],
      height: 110,
      tickEvery: 3,
      tipTitle: (k) => `${new Date(a.hourly[k].t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit' })} 時`,
    });
    const pc = card.querySelector('.plan-chart');
    if (pc) {
      percentLineChart(pc, {
        from: now - 14 * 86400000,
        to: now,
        series: [
          { name: '5 小時', color, points: a.plan.history.map((h) => ({ t: h.t, v: h.fiveHour })) },
          { name: '7 天', color, dash: true, points: a.plan.history.map((h) => ({ t: h.t, v: h.sevenDay })) },
        ],
      });
    }
  });
  antigravity.forEach((g) => {
    const card = document.querySelector(`.card[data-id="${CSS.escape(g.key)}"]`);
    barChart(card.querySelector('.ag-chart'), {
      categories: g.daily.map((d) => d.date.slice(5).replace('-', '/')),
      series: [{ name: '步驟', color: AG_COLOR, values: g.daily.map((d) => d.steps) }],
      height: 110,
      tickEvery: 3,
      tipTitle: (k) => `${g.daily[k].date} · ${g.daily[k].conversations} 個對話`,
    });
  });

  // cross-account daily comparison
  const days = claude[0] ? claude[0].daily.map((d) => d.date) : [];
  const series = claude.map((a, i) => ({ name: a.remote ? `${a.label} @${a.machine}` : a.label, color: SERIES[i % SERIES.length], values: a.daily.map((d) => d.output) }));
  $('#daily-legend').innerHTML = series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('') : '';
  if (days.length) {
    barChart($('#daily-chart'), { categories: days.map((d) => d.slice(5).replace('-', '/')), series, height: 200, tipTitle: (k) => days[k] });
    $('#daily-table').innerHTML = `<table><thead><tr><th>日期</th>${series.map((x) => `<th>${esc(x.name)}</th>`).join('')}</tr></thead><tbody>${days
      .map((d, k) => `<tr><td>${d}</td>${claude.map((a) => `<td class="num">${a.daily[k].output.toLocaleString()}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  }
}

// ---------- settings dialog ----------
async function openSettings() {
  const { value, file, hostname, share } = await dashboard.getSettings();
  const f = $('#settings-form');
  f.refreshSeconds.value = value.refreshSeconds;
  f.closeToTray.checked = value.closeToTray;
  f.machineName.value = value.machineName;
  f.machineName.placeholder = hostname;
  f.shareEnabled.checked = value.share.enabled;
  f.sharePort.value = value.share.port;
  f.shareToken.value = value.share.token;
  f.remotes.value = value.remotes.map((r) => [r.name, r.url, r.token].join(' | ')).join('\n');
  $('#share-status').textContent = share.running
    ? `分享中。另一台電腦填入：http://${(share.addresses || ['<本機IP>'])[0]}:${share.port}${share.addresses && share.addresses.length > 1 ? `（其他 IP：${share.addresses.slice(1).join(', ')}）` : ''}`
    : share.error ? `無法啟動分享：${share.error}` : '分享未開啟。';
  f.extraConfigDirs.value = value.claude.extraConfigDirs.join('\n');
  f.quotaProbe.checked = value.antigravity.quotaProbe;
  f.agDataDirs.value = value.antigravity.dataDirs.join('\n');
  const seen = new Set();
  const accts = (snapshot ? snapshot.claude : []).filter((a) => !seen.has(a.id) && seen.add(a.id));
  $('#label-fields').innerHTML = accts.map((a) => `<label class="row">顯示名稱 · ${esc(a.orgUuid ? 'org ' + a.orgUuid.slice(0, 8) : a.id.slice(0, 12))}${a.remote ? ` @${esc(a.machine)}` : ''}
      <input type="text" data-label="${esc(a.id)}" value="${esc(value.claude.labels[a.id] || '')}" placeholder="${esc(a.label)}" /></label>`).join('');
  $('#settings-file').textContent = `設定檔：${file}`;
  $('#settings').showModal();
}
$('#share-newtoken').addEventListener('click', async () => {
  $('#settings-form').shareToken.value = await dashboard.newShareToken();
});
$('#share-copy').addEventListener('click', () => navigator.clipboard.writeText($('#settings-form').shareToken.value));
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return;
  const { value } = await dashboard.getSettings();
  const f = $('#settings-form');
  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const labels = { ...value.claude.labels };
  document.querySelectorAll('[data-label]').forEach((i) => {
    if (i.value.trim()) labels[i.dataset.label] = i.value.trim();
    else delete labels[i.dataset.label];
  });
  const remotes = lines(f.remotes.value).map((l) => {
    const [name, url, token] = l.split('|').map((x) => (x || '').trim());
    return url ? { name, url, token } : { name: '', url: name, token: '' };
  });
  settings = await dashboard.saveSettings({
    ...value,
    refreshSeconds: Math.max(3, Number(f.refreshSeconds.value) || 10),
    closeToTray: f.closeToTray.checked,
    machineName: f.machineName.value.trim(),
    share: { enabled: f.shareEnabled.checked, port: Math.min(65535, Math.max(1024, Number(f.sharePort.value) || 47821)), token: f.shareToken.value.trim() || value.share.token },
    remotes,
    claude: { ...value.claude, extraConfigDirs: lines(f.extraConfigDirs.value), labels },
    antigravity: { ...value.antigravity, quotaProbe: f.quotaProbe.checked, dataDirs: lines(f.agDataDirs.value) },
  });
});

// ---------- wiring ----------
$('#btn-refresh').addEventListener('click', () => dashboard.refresh());
$('#btn-settings').addEventListener('click', openSettings);
$('#btn-pin').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  await dashboard.setAlwaysOnTop(on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
});
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 120);
});
function updatedLine() {
  if (!snapshot) return;
  const ms = (snapshot.machines || []).map((m) => `${m.ok ? '●' : '○'} ${m.name}${m.local ? '（本機）' : ''}`).join('  ');
  const share = snapshot.share && snapshot.share.running ? ` · 分享中 :${snapshot.share.port}` : '';
  const t = snapshot.timings || {};
  const cost = t.claude != null ? ` · 讀取 ${((t.claude + t.antigravity) / 1000).toFixed(1)} 秒` : '';
  $('#updated').textContent = `更新於 ${rel(snapshot.at)} · 每 ${settings ? settings.refreshSeconds : 10} 秒${share}${cost}　${ms}`;
  $('#updated').title = t.claude != null ? `Claude ${t.claude} ms · Antigravity ${t.antigravity} ms` : '';
}
setInterval(updatedLine, 5000);

dashboard.onSnapshot((s) => {
  snapshot = s;
  render();
});
dashboard.getSettings().then(({ value }) => {
  settings = value;
  $('#btn-pin').setAttribute('aria-pressed', String(!!value.alwaysOnTop));
});
