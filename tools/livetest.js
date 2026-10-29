#!/usr/bin/env node
// Checks the live server end to end with the owner key: two throwaway members join, swap an
// encrypted message, and are removed again. Run: node tools/livetest.js   (Node 22+)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../app/ui/protocol.js');
const SERVER = process.env.SERVER || require('../app/ui/config.js').SERVER;
const FILE = path.join(process.env.PWC_OWNER_DIR || path.join(os.homedir(), '.privatewebchat'), 'owner.json');

const step = msg => console.log('✓ ' + msg);
function open(onHello) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(SERVER);
    const c = { ws, got: [], waiters: [], send: m => ws.send(JSON.stringify(m)) };
    c.next = (t, ms = 20000) => new Promise((r, j) => {
      const i = c.got.findIndex(m => m.t === t);
      if (i >= 0) return r(c.got.splice(i, 1)[0]);
      const w = { t, r }; c.waiters.push(w);
      setTimeout(() => j(new Error(`No "${t}" from the server within ${ms / 1000}s`)), ms);
    });
    const t = setTimeout(() => rej(new Error(`No answer from ${SERVER} (a sleeping Render server can take a minute)`)), 90000);
    ws.onerror = () => { clearTimeout(t); rej(new Error(`Couldn't reach ${SERVER}`)); };
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') { clearTimeout(t); await onHello(c, m); return res(c); }
      const w = c.waiters.findIndex(x => x.t === m.t);
      if (w >= 0) c.waiters.splice(w, 1)[0].r(m); else c.got.push(m);
    };
  });
}

(async () => {
  const owner = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const tag = Date.now().toString(36).slice(-5);
  const people = [];
  for (const n of ['zzcheck_a', 'zzcheck_b']) {
    const keys = await P.generateKeys();
    const cert = await P.acceptInvite(await P.makeInvite(owner.cert, owner.keys, 1), keys, `${n}${tag}`.slice(0, 24));
    const c = await open(async (c, m) => {
      if (m.net !== owner.keys.sigPub) throw new Error("The server's OWNER_KEY doesn't match ~/.privatewebchat/owner.json");
      c.send({ t: 'auth', cert, sig: await P.sign(keys.sigPriv, ['pwc-auth', m.nonce]), dir: [] });
    });
    step(`${cert.m.name} connected to ${SERVER}`);
    const w = await Promise.race([c.next('welcome'), c.next('denied').then(d => { throw new Error('Denied: ' + d.msg); })]);
    step(`${cert.m.name} was let in`);
    people.push({ c, keys, id: w.id, cert });
  }
  const [a, b] = people;
  const box = P.createBox(a.id, a.keys.ecdhPriv);
  a.c.send({ t: 'send', ref: 1, ...(await box.seal({ text: 'hello from the live test' }, [{ id: b.id, ecdh: b.cert.m.ecdh }])) });
  const sent = await a.c.next('sent');
  if (sent.n !== 1) throw new Error('The server had nobody to deliver to');
  const env = await b.c.next('env');
  const msg = await P.createBox(b.id, b.keys.ecdhPriv).open(env, a.cert.m.ecdh);
  if (!msg || msg.text !== 'hello from the live test') throw new Error("The message arrived but couldn't be decrypted");
  b.c.send({ t: 'ack', eids: [env.eid] });
  step('an encrypted message went through the server and decrypted on the other side');

  // Tidy up: remove the two test members
  const o = await open(async (c, m) => c.send({ t: 'owner', sig: await P.sign(owner.keys.sigPriv, ['pwc-owner', m.nonce]) }));
  const dir = await o.next('owner_dir');
  const prev = dir.removals || { v: 0, ids: [] };
  o.send({ t: 'removals', removals: await P.signRemovals(owner.keys, prev.v + 1, [...new Set([...prev.ids, a.id, b.id])]) });
  await a.c.next('removed');
  step('test members removed');
  for (const x of [a.c, b.c, o]) x.ws.close();
  console.log('\nThe live server works.');
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
