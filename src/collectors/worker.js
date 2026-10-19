// Runs the collectors on a worker thread so heavy transcript parsing never freezes the window.
// Lives for the app's lifetime, so the incremental JSONL cache in claude.js is kept between refreshes.
const { parentPort } = require('worker_threads');
const { collectClaude, claudeSearchPaths } = require('./claude');
const { collectAntigravity, antigravitySearchPaths } = require('./antigravity');

parentPort.on('message', async ({ id, settings }) => {
  const errors = [];
  const timings = { claude: 0, antigravity: 0 };
  let claude = [];
  let antigravity = [];
  const claudeOn = settings.claude.enabled !== false;
  const agOn = settings.antigravity.enabled !== false;

  let t = Date.now();
  if (claudeOn) {
    try {
      claude = collectClaude(settings.claude);
    } catch (e) {
      errors.push({ key: 'err_source', vars: { source: 'Claude', e: e.message } });
    }
  }
  timings.claude = Date.now() - t;

  t = Date.now();
  if (agOn) {
    try {
      antigravity = await collectAntigravity(settings.antigravity);
    } catch (e) {
      errors.push({ key: 'err_source', vars: { source: 'Antigravity', e: e.message } });
    }
  }
  timings.antigravity = Date.now() - t;

  // Tell the UI what was searched, so an empty dashboard can explain itself.
  const sources = {
    claude: { enabled: claudeOn, found: claude.length > 0, paths: claudeSearchPaths(settings.claude) },
    antigravity: { enabled: agOn, found: antigravity.length > 0, paths: antigravitySearchPaths(settings.antigravity) },
  };
  parentPort.postMessage({ id, claude, antigravity, errors, timings, sources });
});
