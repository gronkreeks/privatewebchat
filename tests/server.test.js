// The relay end to end: invites, unique usernames, delivery, acks, removals and restarts. Run: node tests/server.test.js
const P = require('../app/ui/protocol.js');
const { spawn } = require('child_process');
const assert = require('assert');
const PORT = 18000 + Math.floor(Math.random() * 1000);
let srv;
function startServer(owner) {
  return new Promise(res => {
    srv = spawn('node', [require('path').join(__dirname, '../server/index.js')], { env: { ...process.env, PORT, OWNER_KEY: owner } });
    srv.stdout.on('data', d => { if (String(d).includes('Hush relay on port')) res(); });
    srv.stderr.on('data', d => process.stderr.write('SERVER: ' + d));
  });
}
// A minimal client: authenticates, then collects messages
function client(keys, cert, dir = [], removals = null) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const c = { ws, got: [], waiters: [], send: m => ws.send(JSON.stringify(m)) };
    c.next = (t) => new Promise(r => {
      const i = c.got.findIndex(m => m.t === t);
      if (i >= 0) return r(c.got.splice(i, 1)[0]);
      c.waiters.push({ t, r });
    });
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') {
        c.send({ t: 'auth', cert, sig: await P.sign(keys.sigPriv, ['hush-auth', m.nonce]), dir, removals });
        return;
      }
      const w = c.waiters.findIndex(x => x.t === m.t);
      if (w >= 0) c.waiters.splice(w, 1)[0].r(m); else c.got.push(m);
      if (m.t === 'welcome' || m.t === 'denied') res(c);
    };
    ws.onerror = rej;
  });
}
(async () => {
  const ok = await P.generateKeys(), alice = await P.generateKeys(), eve = await P.generateKeys();
  const oc = await P.ownerCert(ok, 'Owner');
  const oid = await P.idOf(ok.sigPub);
  await startServer(ok.sigPub);
  const o = await client(ok, oc);
  assert.strictEqual(o.got.pop().t, 'welcome');
  const inv = await P.makeInvite(oc, ok, 24);
  const ac = await P.acceptInvite(inv, alice, 'Alice');
  const aid = await P.idOf(alice.sigPub);
  const a = await client(alice, ac);
  const aw = a.got.pop();
  assert.strictEqual(aw.t, 'welcome'); assert.strictEqual(aw.dir.length, 2);
  assert.strictEqual((await o.next('member')).cert.m.name, 'Alice');
  assert.strictEqual((await o.next('presence')).id, aid);
  // second use of the same invite is refused
  const e = await client(eve, await P.acceptInvite(inv, eve, 'Eve'));
  assert.strictEqual(e.got.pop().why, 'member');
  // usernames are unique, ignoring case
  const inv3 = await P.makeInvite(oc, ok, 24);
  const dup = await client(eve, await P.acceptInvite(inv3, eve, 'alice'));
  assert.strictEqual(dup.got.pop().why, 'name', 'taken username refused');
  const fresh = await client(eve, await P.acceptInvite(inv3, eve, 'Eve'));
  assert.strictEqual(fresh.got.pop().t, 'welcome', 'same invite works with a free name');
  await o.next('member'); await o.next('presence');
  // message: alice -> owner
  const box = P.createBox(aid, alice.ecdhPriv), obox = P.createBox(oid, ok.ecdhPriv);
  const sealed = await box.seal({ k: 'msg', room: 'general', mid: 'abc', text: 'hello owner' }, [{ id: oid, ecdh: ok.ecdhPub }]);
  a.send({ t: 'send', ref: 'abc', ...sealed });
  assert.strictEqual((await a.next('sent')).n, 1);
  const env = await o.next('env');
  assert.strictEqual(env.from, aid);
  assert.strictEqual((await obox.open(env, alice.ecdhPub)).text, 'hello owner');
  // unacked envelopes come back after reconnecting; acked ones don't
  o.ws.close(); await new Promise(r => setTimeout(r, 200));
  const o2 = await client(ok, oc);
  const again = await o2.next('env');
  assert.strictEqual(again.eid, env.eid);
  o2.send({ t: 'ack', eids: [env.eid] });
  await new Promise(r => setTimeout(r, 200));
  o2.ws.close(); await new Promise(r => setTimeout(r, 200));
  const o3 = await client(ok, oc);
  await new Promise(r => setTimeout(r, 300));
  assert(!o3.got.some(m => m.t === 'env'), 'acked envelope not resent');
  // removal disconnects alice
  const rem = await P.signRemovals(ok, 1, [aid]);
  o3.send({ t: 'removals', removals: rem });
  assert.strictEqual((await a.next('removed')).t, 'removed');
  // restart the server: it forgets everything, then learns it back from the apps
  srv.kill(); await new Promise(r => setTimeout(r, 300));
  await startServer(ok.sigPub);
  const o4 = await client(ok, oc, [oc, ac], rem);
  assert.strictEqual(o4.got.pop().dir.length, 1, 'removed member not re-admitted from uploaded directory');
  const a2 = await client(alice, ac);
  assert.strictEqual(a2.got.pop().why, 'member', 'removed member refused after restart');
  // unset server
  srv.kill(); await new Promise(r => setTimeout(r, 300));
  await startServer('');
  const o5 = await client(ok, oc);
  assert.strictEqual(o5.got.pop().why, 'setup');
  console.log('all server tests passed');
  srv.kill(); process.exit(0);
})().catch(e => { console.error('FAIL', e); if (srv) srv.kill(); process.exit(1); });
