// Two-machine simulation on loopback: share server, connection code, remote fetch (auth, fallback addresses, stale data).
const assert = require('assert');
const { applyShare, fetchRemote, makeCode, parseCode } = require('../src/remote');

(async () => {
  const snap = { at: Date.now(), machine: 'PC-2', claude: [{ id: 'acct-2', label: 'acct2' }], antigravity: [] };
  const share = { enabled: true, port: 47899, token: 'secret-token', host: '127.0.0.1' };
  await new Promise((r) => applyShare(share, () => snap, (st) => { assert(st.running, JSON.stringify(st)); r(); }));

  // A code listing an unreachable address first must still connect via the next one.
  const code = makeCode({ name: 'PC-2', port: 47899, token: 'secret-token', addresses: ['10.255.255.1', '127.0.0.1'] });
  const remote = parseCode(code);
  assert.deepStrictEqual(remote.name, 'PC-2');
  assert(remote.urls.includes('http://127.0.0.1:47899'));
  console.log('connection code round-trips:', remote.urls.length, 'addresses');

  const ok = await fetchRemote(remote);
  assert(ok.ok && ok.snap.claude[0].id === 'acct-2' && ok.url.includes('127.0.0.1'));
  console.log('falls back to a working address + snapshot received');

  assert.deepStrictEqual(parseCode('Mac | http://127.0.0.1:47899 | secret-token'), { name: 'Mac', urls: ['http://127.0.0.1:47899'], token: 'secret-token' });
  assert.strictEqual(parseCode('garbage'), null);
  assert.strictEqual(parseCode('aiag1:not-base64-json'), null);
  console.log('manual "name | url | token" accepted, garbage rejected');

  const bad = await fetchRemote({ ...remote, token: 'wrong' });
  assert(!bad.ok && bad.error.key === 'err_badToken');
  console.log('wrong token rejected');

  applyShare({ ...share, enabled: false }, () => snap, () => {});
  await new Promise((r) => setTimeout(r, 200));
  const down = await fetchRemote(remote);
  assert(!down.ok && down.snap && down.snap.machine === 'PC-2');
  console.log('offline -> stale fallback:', down.error.key || down.error.text);
  console.log('ALL PASS');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
