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
  // Only the owner can invite: an invite made by a member doesn't work
  const memberInv = await P.makeInvite(ac, alice, 1);
  assert(!(await P.verifyCert(await P.acceptInvite(memberInv, bob, 'Bob'), ok.sigPub)), 'member-made invite rejected');
  const inv2 = await P.makeInvite(oc, ok, 1);
  const bc = await P.acceptInvite(inv2, bob, 'Bob');
  const bi = await P.verifyCert(JSON.parse(JSON.stringify(bc)), ok.sigPub);
  assert(bi && bi.chain.join() === oi.id && bi.by === oi.id, 'bob invited by the owner');
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
  assert(rr && P.isRemoved(ai, new Set(rr.ids)) && !P.isRemoved(bi, new Set(rr.ids)) && !P.isRemoved(oi, new Set(rr.ids)), 'removal');
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
  // short invite codes give the same kind of certificate as long ones
  const code = await P.makeShortInvite(ok.sigPriv, 24);
  assert(code.startsWith('PWC2.') && code.length === 117, 'short code is 117 characters');
  const si = await P.readShortInvite(code, oc);
  const sc = await P.acceptInvite(si, eve, 'Eve');
  const sci = await P.verifyCert(JSON.parse(JSON.stringify(sc)), ok.sigPub);
  assert(sci && sci.by === oi.id && sci.ik === si.g.ik, 'short invite cert');
  assert(Math.abs(si.g.exp - (Date.now() + 24 * 3600000)) < 120000, 'short invite expiry');
  assert.strictEqual((await P.readShortInvite(code, oc)).g.ik, si.g.ik, 'same code, same invite key');
  const bad = code.slice(0, 30) + (code[30] === 'A' ? 'B' : 'A') + code.slice(31);
  const bi2 = await P.readShortInvite(bad, oc);
  assert(!bi2 || !(await P.verifyCert(await P.acceptInvite(bi2, eve, 'Eve'), ok.sigPub)), 'changed short code rejected');
  const forged = await P.readShortInvite(await P.makeShortInvite(alice.sigPriv, 24), oc);
  assert(!(await P.verifyCert(await P.acceptInvite(forged, eve, 'Eve'), ok.sigPub)), 'short code not signed by the owner rejected');
  assert(!(await P.readShortInvite('PWC2.short', oc)), 'malformed short code');
  // spoken codes: 12 digits that unlock an ordinary invite code kept (encrypted) by the server
  const sp = await P.makeSpoken(ok.sigPriv, ok.sigPub, code, 24);
  assert(/^\d{12}$/.test(sp.code) && P.isSpoken(P.fmtSpoken(sp.code)) && P.fmtSpoken(sp.code).length === 14, 'twelve digits, said in threes of four');
  const spe = await P.checkSpoken(JSON.parse(JSON.stringify(sp.entry)), ok.sigPub);
  assert(spe && !JSON.stringify(spe).includes(code.slice(5, 40)), 'entry signed by the owner, invite encrypted');
  const other = await P.checkSpoken((await P.makeSpoken(ok.sigPriv, ok.sigPub, 'PWC2.other', 24)).entry, ok.sigPub);
  assert.strictEqual(await P.openSpoken(P.fmtSpoken(sp.code), ok.sigPub, [other, spe]), code, 'the code opens its own entry among others');
  const wrong = String((Number(sp.code[11]) + 1) % 10);
  assert.strictEqual(await P.openSpoken(sp.code.slice(0, 11) + wrong, ok.sigPub, [spe]), null, 'a wrong digit opens nothing');
  assert(!(await P.checkSpoken({ ...sp.entry, exp: sp.entry.exp + 1 }, ok.sigPub)), 'changed entry rejected');
  assert(!(await P.checkSpoken((await P.makeSpoken(alice.sigPriv, ok.sigPub, code, 24)).entry, ok.sigPub)), 'entry not signed by the owner rejected');
  assert(!P.isSpoken('1234 5678 901') && P.isSpoken('1234-5678-9012'), 'twelve digits, spaces or dashes');
  // announcements
  const ann = await P.signAnn(ok.sigPriv, P.randomHex(8), Date.now(), '## v1.1.6\n- Pings');
  assert(await P.checkAnn(JSON.parse(JSON.stringify(ann)), ok.sigPub), 'owner announcement');
  assert(!(await P.checkAnn({ ...ann, text: 'changed' }, ok.sigPub)), 'edited announcement rejected');
  assert(!(await P.checkAnn(await P.signAnn(alice.sigPriv, ann.id, ann.at, ann.text), ok.sigPub)), 'member announcement rejected');
  console.log('safety', await P.safetyNumber(ac.m));
  console.log('cert size', JSON.stringify(bc).length, 'all protocol tests passed');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
