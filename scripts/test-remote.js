// Two-machine simulation on loopback: share server + remote fetch (auth, merge, stale fallback).
const assert = require('assert');
const { applyShare, fetchRemote } = require('../src/remote');

(async () => {
  const snap = { at: Date.now(), machine: 'PC-2', claude: [{ id: 'acct-2', label: 'acct2' }], antigravity: [] };
  const share = { enabled: true, port: 47899, token: 'secret-token', host: '127.0.0.1' };
  await new Promise((r) => applyShare(share, () => snap, (st) => { assert(st.running, JSON.stringify(st)); r(); }));

  const ok = await fetchRemote({ name: 'PC-2', url: '127.0.0.1:47899', token: 'secret-token' });
  assert(ok.ok && ok.snap.claude[0].id === 'acct-2');
  console.log('auth ok + snapshot received');

  const bad = await fetchRemote({ name: 'PC-2', url: 'http://127.0.0.1:47899', token: 'wrong' });
  assert(!bad.ok && /token/.test(bad.error));
  console.log('wrong token rejected:', bad.error);

  applyShare({ ...share, enabled: false }, () => snap, () => {});
  await new Promise((r) => setTimeout(r, 200));
  const down = await fetchRemote({ name: 'PC-2', url: '127.0.0.1:47899', token: 'secret-token' });
  assert(!down.ok && down.snap && down.snap.machine === 'PC-2');
  console.log('offline -> stale fallback:', down.error);
  console.log('ALL PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
