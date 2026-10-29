// The relay end to end: invites, unique usernames, delivery, acks, expiry, owner requests, removals
// and restarts. Run: node tests/server.test.js   (Node 22+, for the built-in WebSocket client)
const P = require('../app/ui/protocol.js');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const PORT = 18000 + Math.floor(Math.random() * 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv;
function startServer(owner) {
  return new Promise(res => {
    srv = spawn('node', [path.join(__dirname, '../server/index.js')], { env: { ...process.env, PORT, OWNER_KEY: owner } });
    srv.stdout.on('data', d => { if (String(d).includes('privatewebchat relay on port')) res(); });
    srv.stderr.on('data', d => process.stderr.write('SERVER: ' + d));
  });
}
// A minimal client: authenticates (or, with owner keys, makes an owner request), then collects messages
function client(keys, cert, opts = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const c = { ws, got: [], waiters: [], send: m => ws.send(JSON.stringify(m)) };
    c.next = t => new Promise(r => {
      const i = c.got.findIndex(m => m.t === t);
      if (i >= 0) return r(c.got.splice(i, 1)[0]);
      c.waiters.push({ t, r });
    });
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') {
        if (opts.owner) c.send({ t: 'owner', sig: await P.sign(keys.sigPriv, ['pwc-owner', m.nonce]) });
        else c.send({ t: 'auth', cert, sig: await P.sign(keys.sigPriv, ['pwc-auth', m.nonce]), dir: opts.dir || [], removals: opts.removals || null });
        return;
      }
      const w = c.waiters.findIndex(x => x.t === m.t);
      if (w >= 0) c.waiters.splice(w, 1)[0].r(m); else c.got.push(m);
      if (['welcome', 'denied', 'owner_dir'].includes(m.t)) res(c);
    };
    ws.onerror = rej;
  });
}
const last = c => c.got.pop();

(async () => {
  const ok = await P.generateKeys(), alice = await P.generateKeys(), bob = await P.generateKeys(), eve = await P.generateKeys();
  const oc = await P.ownerCert(ok, 'developer');
  await startServer(ok.sigPub);

  // The owner key can't be used to chat
  assert.strictEqual(last(await client(ok, oc)).why, 'member', 'owner cannot join as a member');

  const ac = await P.acceptInvite(await P.makeInvite(oc, ok, 24), alice, 'alice');
  const aid = await P.idOf(alice.sigPub);
  const invB = await P.makeInvite(oc, ok, 24);
  const bc = await P.acceptInvite(invB, bob, 'bob');
  const bid = await P.idOf(bob.sigPub);
  const a = await client(alice, ac);
  assert.strictEqual(last(a).t, 'welcome');
  const b = await client(bob, bc);
  const bw = last(b);
  assert.strictEqual(bw.t, 'welcome'); assert.strictEqual(bw.dir.length, 2, 'directory has both members and not the owner');
  assert.strictEqual((await a.next('member')).cert.m.name, 'bob');
  assert.strictEqual((await a.next('presence')).id, bid);

  // A used invite is refused; a taken username is refused (ignoring case) and the invite still works after
  assert.strictEqual(last(await client(eve, await P.acceptInvite(invB, eve, 'eve'))).why, 'member', 'used invite refused');
  const invE = await P.makeInvite(oc, ok, 24);
  assert.strictEqual(last(await client(eve, await P.acceptInvite(invE, eve, 'ALICE'))).why, 'name', 'taken username refused');
  const e = await client(eve, await P.acceptInvite(invE, eve, 'eve'));
  assert.strictEqual(last(e).t, 'welcome', 'same invite works with a free name');
  // Invites made by a member don't work
  const fake = await P.acceptInvite(await P.makeInvite(ac, alice, 24), (await P.generateKeys()), 'mallory');
  assert.strictEqual(last(await client(eve, fake)).why, 'member', 'member-made invite refused');

  // Messages: alice -> bob
  const boxA = P.createBox(aid, alice.ecdhPriv), boxB = P.createBox(bid, bob.ecdhPriv);
  const sealed = await boxA.seal({ k: 'msg', room: 'general', mid: 'abc', text: 'hello bob' }, [{ id: bid, ecdh: bob.ecdhPub }]);
  a.send({ t: 'send', ref: 'abc', ...sealed });
  assert.strictEqual((await a.next('sent')).n, 1);
  const env = await b.next('env');
  assert.strictEqual(env.from, aid);
  assert.strictEqual((await boxB.open(env, alice.ecdhPub)).text, 'hello bob');
  // Unacked envelopes come back after reconnecting; acked ones don't
  b.ws.close(); await sleep(200);
  const b2 = await client(bob, bc);
  assert.strictEqual((await b2.next('env')).eid, env.eid, 'unacked envelope resent');
  b2.send({ t: 'ack', eids: [env.eid] }); await sleep(200);
  b2.ws.close(); await sleep(200);
  const b3 = await client(bob, bc); await sleep(300);
  assert(!b3.got.some(m => m.t === 'env'), 'acked envelope not resent');
  // Envelopes that expire (DMs ask for 24 hours) aren't delivered late
  b3.ws.close(); await sleep(200);
  const short = await boxA.seal({ k: 'msg', room: 'dm', mid: 'gone', text: 'expires' }, [{ id: bid, ecdh: bob.ecdhPub }]);
  a.send({ t: 'send', ref: 'gone', ttl: 1000, ...short });
  await a.next('sent');
  await sleep(1300);
  const b4 = await client(bob, bc); await sleep(300);
  assert(!b4.got.some(m => m.t === 'env'), 'expired envelope not delivered');

  // Owner requests: the member list needs the owner key; removals need no login, only the owner's signature
  assert.strictEqual(last(await client(alice, ac, { owner: true })).why, 'owner', 'member cannot list as owner');
  const od = last(await client(ok, oc, { owner: true }));
  assert.deepStrictEqual(od.dir.map(c => c.m.name).sort(), ['alice', 'bob', 'eve'], 'owner sees the member list');
  const rem = await P.signRemovals(ok, 1, [aid]);
  const anon = new WebSocket(`ws://127.0.0.1:${PORT}`);
  await new Promise(r => { anon.onopen = r; });
  anon.send(JSON.stringify({ t: 'removals', removals: rem }));
  assert.strictEqual((await a.next('removed')).t, 'removed', 'removed member disconnected');
  anon.send(JSON.stringify({ t: 'removals', removals: await P.signRemovals(alice, 2, [bid]) }));
  await sleep(300);
  assert.strictEqual(b4.ws.readyState, 1, 'removals not signed by the owner are ignored');

  // Restart: the server forgets everything, then learns it back from the apps
  srv.kill(); await sleep(300);
  await startServer(ok.sigPub);
  const b5 = await client(bob, bc, { dir: [ac, bc], removals: rem });
  assert.deepStrictEqual(last(b5).dir.map(c => c.m.name), ['bob'], 'removed member not re-admitted from an uploaded directory');
  assert.strictEqual(last(await client(alice, ac)).why, 'member', 'removed member refused after restart');

  // Usernames go to whoever had them first: backdating the join time in a cert doesn't help
  const carol = await P.generateKeys(), mal = await P.generateKeys();
  const certAt = async (keys, name, at) => {
    const inv = await P.makeInvite(oc, ok, 24), m = { name, sig: keys.sigPub, ecdh: keys.ecdhPub, at };
    return { m, by: inv.g, s: await P.sign(inv.k, ['pwc-join', m]) };
  };
  const cc = await P.acceptInvite(await P.makeInvite(oc, ok, 24), carol, 'carol');
  assert.strictEqual(last(await client(carol, cc)).t, 'welcome');
  assert.strictEqual(last(await client(mal, await certAt(mal, 'Carol', 1))).why, 'name', 'backdated cert cannot take a name');

  // After a restart, whoever grabs a name first gives way once another member's app vouches for the real holder
  srv.kill(); await sleep(300);
  await startServer(ok.sigPub);
  const mc = await client(mal, await certAt(mal, 'carol', Date.now()));
  assert.strictEqual(last(mc).t, 'welcome', 'name free while the server is empty');
  assert.strictEqual(last(await client(carol, cc)).why, 'name', 'real holder waits while nobody vouches for her');
  await client(bob, bc, { dir: [bc, cc], removals: rem });
  assert.strictEqual((await mc.next('denied')).why, 'name', 'name grabber dropped');
  assert.strictEqual(last(await client(carol, cc)).t, 'welcome', 'real holder gets her name back');

  // A server without OWNER_KEY
  srv.kill(); await sleep(300);
  await startServer('');
  assert.strictEqual(last(await client(bob, bc)).why, 'setup');
  console.log('all server tests passed');
  srv.kill(); process.exit(0);
})().catch(e => { console.error('FAIL', e); if (srv) srv.kill(); process.exit(1); });
