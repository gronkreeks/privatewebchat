// Certificates, invites, removals and message encryption (app/ui/protocol.js). Run: node tests/protocol.test.js
const P = require('../app/ui/protocol.js');
const assert = require('assert');
(async () => {
  const ok = await P.generateKeys(), alice = await P.generateKeys(), bob = await P.generateKeys(), eve = await P.generateKeys();
  const oc = await P.ownerCert(ok, 'Owner');
  const oi = await P.verifyCert(oc, ok.sigPub);
  assert(oi && oi.chain.length === 0, 'owner cert');
  assert(!(await P.verifyCert(oc, alice.sigPub)), 'wrong owner rejected');
  const inv = await P.makeInvite(oc, ok, 24);
  const ac = await P.acceptInvite(inv, alice, 'Alice');
  const ai = await P.verifyCert(ac, ok.sigPub);
  assert(ai && ai.by === oi.id && ai.ik === inv.g.ik, 'alice cert');
  const inv2 = await P.makeInvite(ac, alice, 1);
  const bc = await P.acceptInvite(inv2, bob, 'Bob');
  const bi = await P.verifyCert(JSON.parse(JSON.stringify(bc)), ok.sigPub);
  assert(bi && bi.chain.join() === [oi.id, ai.id].join(), 'bob chain');
  // tampering
  const t1 = JSON.parse(JSON.stringify(bc)); t1.m.name = 'Mallory';
  assert(!(await P.verifyCert(t1, ok.sigPub)), 'renamed cert rejected');
  const t2 = JSON.parse(JSON.stringify(bc)); t2.m.ecdh = eve.ecdhPub;
  assert(!(await P.verifyCert(t2, ok.sigPub)), 'swapped key rejected');
  const t3 = JSON.parse(JSON.stringify(bc)); t3.by.exp += 1;
  assert(!(await P.verifyCert(t3, ok.sigPub)), 'extended invite rejected');
  // self-made invite chain from a non-member
  const fake = await P.makeInvite({ m: { name: 'Eve', sig: eve.sigPub, ecdh: eve.ecdhPub, at: 1 }, s: 'x' }, eve, 1);
  assert(!(await P.verifyCert(await P.acceptInvite(fake, eve, 'Eve'), ok.sigPub)), 'outsider invite rejected');
  // removals
  const rem = await P.signRemovals(ok, 1, [ai.id]);
  const rr = await P.checkRemovals(JSON.parse(JSON.stringify(rem)), ok.sigPub);
  assert(rr && P.isRemoved(bi, new Set(rr.ids)) && P.isRemoved(ai, new Set(rr.ids)) && !P.isRemoved(oi, new Set(rr.ids)), 'removal subtree');
  assert(!(await P.checkRemovals(await P.signRemovals(alice, 2, [oi.id]), ok.sigPub)), 'non-owner removal rejected');
  // messages
  const boxA = P.createBox(ai.id, alice.ecdhPriv), boxB = P.createBox(bi.id, bob.ecdhPriv), boxO = P.createBox(oi.id, ok.ecdhPriv);
  const sealed = await boxA.seal({ k: 'msg', text: 'hi ✓ 🎉' }, [{ id: bi.id, ecdh: bob.ecdhPub }, { id: oi.id, ecdh: ok.ecdhPub }]);
  const envB = { from: ai.id, iv: sealed.iv, ct: sealed.ct, key: sealed.keys[bi.id] };
  assert.deepStrictEqual(await boxB.open(envB, alice.ecdhPub), { k: 'msg', text: 'hi ✓ 🎉' }, 'bob opens');
  assert((await boxO.open({ ...envB, key: sealed.keys[oi.id] }, alice.ecdhPub)).text === 'hi ✓ 🎉', 'owner opens');
  assert((await boxB.open({ ...envB, from: oi.id }, ok.ecdhPub)) === null, 'relabelled sender rejected');
  assert((await boxO.open(envB, alice.ecdhPub)) === null, "someone else's key rejected");
  assert(P.isB64(sealed.keys[bi.id], P.WRAPPED, P.WRAPPED) && P.isB64(sealed.iv, P.IV, P.IV), 'sizes match server checks');
  console.log('safety', await P.safetyNumber(ac.m));
  console.log('cert size', JSON.stringify(bc).length, 'all protocol tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
