// Runs the collectors once outside Electron and prints a summary.
const { collectClaude } = require('../src/collectors/claude');
const { collectAntigravity } = require('../src/collectors/antigravity');

(async () => {
  const t0 = Date.now();
  const claude = collectClaude({});
  const t1 = Date.now();
  const ag = await collectAntigravity({});
  const t2 = Date.now();
  for (const a of claude) {
    console.log(`[claude] ${a.label} org=${(a.orgUuid || '').slice(0, 8)} plan=${JSON.stringify(a.plan && { fh: a.plan.fiveHour, sd: a.plan.sevenDay, hist: a.plan.history.length })}`);
    console.log(`   today out=${a.today.output} in=${a.today.input} cacheR=${a.today.cacheRead} msgs=${a.today.messages}; counts=${JSON.stringify(a.counts)}`);
    for (const s of a.sessions.slice(0, 5)) console.log(`   - ${s.state.padEnd(8)} ${s.title || s.sessionId} [${s.project}] ${s.model} out=${s.tokens.output}`);
  }
  for (const g of ag) {
    console.log(`[ag] ${g.label} app=${g.appRunning} ls=${g.languageServerRunning} err=${g.error} counts=${JSON.stringify(g.counts)}`);
    for (const c of g.conversations.slice(0, 4)) console.log(`   - ${c.state.padEnd(8)} ${c.title.slice(0, 40)} [${c.project}] steps=${c.steps} ${new Date(c.lastActivity).toISOString()}`);
  }
  console.log(`claude ${t1 - t0}ms, antigravity ${t2 - t1}ms`);
})();
