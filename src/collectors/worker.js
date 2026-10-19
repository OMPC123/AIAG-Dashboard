// Runs the collectors on a worker thread so heavy transcript parsing never freezes the window.
// Lives for the app's lifetime, so the incremental JSONL cache in claude.js is kept between refreshes.
const { parentPort } = require('worker_threads');
const { collectClaude } = require('./claude');
const { collectAntigravity } = require('./antigravity');

parentPort.on('message', async ({ id, settings }) => {
  const errors = [];
  const timings = {};
  let claude = [];
  let antigravity = [];
  let t = Date.now();
  try {
    claude = collectClaude(settings.claude);
  } catch (e) {
    errors.push(`Claude: ${e.message}`);
  }
  timings.claude = Date.now() - t;
  t = Date.now();
  try {
    antigravity = await collectAntigravity(settings.antigravity);
  } catch (e) {
    errors.push(`Antigravity: ${e.message}`);
  }
  timings.antigravity = Date.now() - t;
  parentPort.postMessage({ id, claude, antigravity, errors, timings });
});
