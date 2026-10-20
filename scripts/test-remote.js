// Two-machine simulation on loopback: share server, connection code, remote fetch (auth, fallback addresses,
// stale data) and rediscovery after an IP change.
const assert = require('assert');
const { _resetForTests, applyShare, fetchRemote, findRemote, makeCode, parseCode } = require('../src/remote');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const snap = { at: Date.now(), machine: 'PC-2', claude: [{ id: 'acct-2', label: 'acct2' }], antigravity: [] };
  const share = { enabled: true, port: 47899, token: 'secret-token', host: '127.0.0.1' };
  const info = () => ({ id: 'pc2-id', name: 'PC-2' });
  await new Promise((r) => applyShare(share, () => snap, (st) => { assert(st.running, JSON.stringify(st)); r(); }, info));

  // A code listing an unreachable address first must still connect via the next one.
  const code = makeCode({ id: 'pc2-id', name: 'PC-2', port: 47899, token: 'secret-token', addresses: ['10.255.255.1', '127.0.0.1'] });
  const remote = parseCode(code);
  assert.strictEqual(remote.name, 'PC-2');
  assert.strictEqual(remote.id, 'pc2-id');
  assert(remote.urls.includes('http://127.0.0.1:47899'));
  console.log('connection code round-trips (with machine id):', remote.urls.length, 'addresses');

  const ok = await fetchRemote(remote, { scan: false });
  assert(ok.ok && ok.snap.claude[0].id === 'acct-2' && ok.url.includes('127.0.0.1'));
  console.log('falls back to a working address + snapshot received');

  assert.deepStrictEqual(parseCode('Mac | http://127.0.0.1:47899 | secret-token'), { id: null, name: 'Mac', urls: ['http://127.0.0.1:47899'], token: 'secret-token' });
  assert.strictEqual(parseCode('garbage'), null);
  assert.strictEqual(parseCode('aiag1:not-base64-json'), null);
  assert.strictEqual(parseCode('X | http://h:1 | aiag1:@@@'), null);
  // the whole code pasted into the token field of a manual line: the code is used, the typed name kept
  const mixed = parseCode(`My PC | http://192.168.1.48:47821 | ${code}`);
  assert.deepStrictEqual([mixed.name, mixed.token, mixed.id], ['My PC', 'secret-token', 'pc2-id']);
  console.log('manual "name | url | token" accepted, code inside a manual line decoded, garbage rejected');

  const bad = await fetchRemote({ ...remote, token: 'wrong' }, { scan: false });
  assert(!bad.ok && bad.error.key === 'err_badToken');
  console.log('wrong token rejected');

  // ---- rediscovery: scanning finds the machine only with the right token and machine id ----
  const hosts = ['127.0.0.5', '127.0.0.6', '127.0.0.1'];
  assert.strictEqual(await findRemote(remote, { hosts }), 'http://127.0.0.1:47899');
  assert.strictEqual(await findRemote({ ...remote, token: 'wrong' }, { hosts }), null);
  assert.strictEqual(await findRemote({ ...remote, id: 'another-machine' }, { hosts }), null);
  console.log('scan finds the machine; wrong token / other machine id are ignored');

  // ---- IP change: the saved address no longer answers; refresh 1 fails and starts a scan, refresh 2 works ----
  _resetForTests(); // nothing cached: the only known address is the old one
  const moved = { id: 'pc2-id', name: 'PC-2-moved', urls: ['http://127.0.0.9:47899'], token: 'secret-token' };
  let found = null;
  const r1 = await fetchRemote(moved, { onFound: (_r, base) => (found = base), hosts });
  assert(!r1.ok, 'first refresh should fail at the old address');
  for (let i = 0; i < 40 && !found; i++) await sleep(100);
  assert.strictEqual(found, 'http://127.0.0.1:47899');
  const r2 = await fetchRemote(moved, { hosts });
  assert(r2.ok && r2.snap.machine === 'PC-2');
  console.log('IP change: rediscovered at', found, 'and the next refresh connects');

  // ---- offline: stale data is kept ----
  applyShare({ ...share, enabled: false }, () => snap, () => {});
  await sleep(200);
  const down = await fetchRemote(remote, { scan: false });
  assert(!down.ok && down.snap && down.snap.machine === 'PC-2');
  console.log('offline -> stale fallback:', down.error.key || down.error.text);
  console.log('ALL PASS');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
