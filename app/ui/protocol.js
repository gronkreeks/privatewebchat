// privatewebchat protocol, shared by the desktop app and the relay server (server/index.js requires this file).
// Every member has two P-256 keys: an ECDSA key that signs and an ECDH key that encrypts.
// Membership is a chain of signatures back to the network owner (owner → invite → member →
// invite → member …), so the server can check that someone was invited without storing anything.
// Messages use the EduArcade chatroom scheme: each message gets its own AES-GCM key, wrapped
// separately for every recipient with an AES-KW key derived (ECDH + HKDF) from the sender's and
// recipient's keys, so the server only relays ciphertext it can't read.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(globalThis.crypto);
  else root.PwcProto = make(root.crypto);
})(this, function (crypto) {
  'use strict';
  const subtle = crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const toB64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const isB64 = (s, min, max) => typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
  const hex = buf => Array.from(new Uint8Array(buf), x => x.toString(16).padStart(2, '0')).join('');
  const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));

  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  // Base64 lengths: a raw P-256 public key is 65 bytes (88 chars), a signature 64 bytes (88),
  // an AES-KW wrapped key 40 bytes (56), an IV 12 bytes (16)
  const PUB = 88, SIG = 88, WRAPPED = 56, IV = 16;
  const MAX_NAME = 24, MAX_DEPTH = 32, MAX_TEXT = 2000;
  const ID_RE = /^[0-9a-f]{32}$/;
  // Usernames are part of a member's certificate, so they can never be changed
  const USERNAME_RE = /^[A-Za-z0-9_.]{2,24}$/;

  // Signatures cover a canonical JSON form: keys sorted, no whitespace
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    return JSON.stringify(v);
  }
  function cleanName(n, max = MAX_NAME) {
    return String(n == null ? '' : n).normalize('NFKC').replace(/[\u0000-\u001f\u007f<>​-‏‪-‮⁠-⁤﻿]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, max);
  }

  async function generateKeys() {
    const s = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const e = await subtle.generateKey(ECDH, true, ['deriveBits']);
    return {
      sigPub: toB64(await subtle.exportKey('raw', s.publicKey)), sigPriv: toB64(await subtle.exportKey('pkcs8', s.privateKey)),
      ecdhPub: toB64(await subtle.exportKey('raw', e.publicKey)), ecdhPriv: toB64(await subtle.exportKey('pkcs8', e.privateKey)),
    };
  }
  async function sign(pkcs8, data) {
    const k = await subtle.importKey('pkcs8', fromB64(pkcs8), ECDSA, false, ['sign']);
    return toB64(await subtle.sign(SIGN, k, te.encode(canon(data))));
  }
  async function verify(pub, data, sig) {
    if (!isB64(pub, PUB, PUB) || !isB64(sig, SIG, SIG)) return false;
    try {
      const k = await subtle.importKey('raw', fromB64(pub), ECDSA, false, ['verify']);
      return await subtle.verify(SIGN, k, fromB64(sig), te.encode(canon(data)));
    } catch (e) { return false; }
  }
  // A member's id is the start of the hash of their signing key
  const idOf = async sigPub => hex(await subtle.digest('SHA-256', fromB64(sigPub))).slice(0, 32);
  // 30 digits two people can compare to make sure the server didn't swap anyone's keys
  async function safetyNumber(m) {
    const h = new Uint8Array(await subtle.digest('SHA-256', te.encode('pwc-safety|' + m.sig + '|' + m.ecdh)));
    let s = '';
    for (let i = 0; i < 6; i++) s += (((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 100000).toString().padStart(5, '0') + ' ';
    return s.trim();
  }

  // ── Membership certificates ──
  // cert = { m: { name, sig, ecdh, at }, s, by }. The owner signs their own m. Everyone else's m is
  // signed by an invite key, and `by` is the invite: { ik, exp, from: inviter's cert, s }.
  const member = (keys, name) => ({ name: String(name), sig: keys.sigPub, ecdh: keys.ecdhPub, at: Date.now() });
  async function ownerCert(keys, name) {
    const m = member(keys, name);
    return { m, s: await sign(keys.sigPriv, ['pwc-owner', m]) };
  }
  // An invite is a fresh key pair whose public half the inviter signs. Whoever holds the private
  // half can sign one member into the network.
  async function makeInvite(myCert, myKeys, hours) {
    const k = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const ik = toB64(await subtle.exportKey('raw', k.publicKey));
    const exp = Date.now() + Math.round(hours * 3600000);
    return { g: { ik, exp, from: myCert, s: await sign(myKeys.sigPriv, ['pwc-invite', ik, exp]) }, k: toB64(await subtle.exportKey('pkcs8', k.privateKey)) };
  }
  async function acceptInvite(inv, keys, name) {
    const m = member(keys, name);
    return { m, by: inv.g, s: await sign(inv.k, ['pwc-join', m]) };
  }
  // Checks a certificate all the way back to the owner. Returns { id, name, sig, ecdh, ik, by, chain }
  // (chain = ids of everyone above this member), or null if anything is wrong.
  async function verifyCert(cert, owner, depth = 0) {
    if (!cert || typeof cert !== 'object' || depth > MAX_DEPTH) return null;
    const m = cert.m;
    if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !USERNAME_RE.test(m.name) ||
      !isB64(m.sig, PUB, PUB) || !isB64(m.ecdh, PUB, PUB) || typeof m.at !== 'number') return null;
    const mm = { name: m.name, sig: m.sig, ecdh: m.ecdh, at: m.at };
    const id = await idOf(m.sig);
    if (!cert.by) {
      if (m.sig !== owner || !(await verify(owner, ['pwc-owner', mm], cert.s))) return null;
      return { id, name: m.name, at: m.at, sig: m.sig, ecdh: m.ecdh, ik: null, by: null, chain: [] };
    }
    const g = cert.by;
    if (typeof g !== 'object' || typeof g.exp !== 'number' || m.at > g.exp) return null;
    if (!(await verify(g.ik, ['pwc-join', mm], cert.s))) return null;
    const up = await verifyCert(g.from, owner, depth + 1);
    // Only the owner (the developer running the server) can invite people
    if (!up || up.by || !(await verify(up.sig, ['pwc-invite', g.ik, g.exp], g.s))) return null;
    if (up.id === id || up.chain.includes(id)) return null;
    return { id, name: m.name, at: m.at, sig: m.sig, ecdh: m.ecdh, ik: g.ik, by: up.id, chain: [...up.chain, up.id] };
  }
  // Removing someone also removes everyone they invited
  const isRemoved = (info, removed) => removed.has(info.id) || info.chain.some(x => removed.has(x));

  // The owner's list of removed members. Every member's app keeps the newest one and hands it to
  // the server when it connects, so removals survive server restarts.
  async function signRemovals(keys, v, ids) { return { v, ids, s: await sign(keys.sigPriv, ['pwc-removed', v, ids]) }; }
  async function checkRemovals(r, owner) {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.v) || r.v < 1 || !Array.isArray(r.ids) || r.ids.length > 5000 ||
      !r.ids.every(x => typeof x === 'string' && ID_RE.test(x))) return null;
    return (await verify(owner, ['pwc-removed', r.v, r.ids], r.s)) ? { v: r.v, ids: r.ids, s: r.s } : null;
  }

  // ── Messages ──
  // seal() returns { iv, ct, keys: { memberId: wrappedKey } }. The payload is any JSON value.
  function createBox(myId, myEcdhPriv) {
    const priv = subtle.importKey('pkcs8', fromB64(myEcdhPriv), ECDH, false, ['deriveBits']);
    const wraps = new Map();   // their ECDH public key -> promise of the AES-KW key shared with them
    function wrapKey(pub) {
      if (!wraps.has(pub)) {
        wraps.set(pub, (async () => {
          const theirs = await subtle.importKey('raw', fromB64(pub), ECDH, false, []);
          const bits = await subtle.deriveBits({ name: 'ECDH', public: theirs }, await priv, 256);
          const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
          return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('pwc-wrap-v1') },
            hk, { name: 'AES-KW', length: 256 }, false, ['wrapKey', 'unwrapKey']);
        })());
      }
      return wraps.get(pub);
    }
    const aad = from => te.encode('pwc-v1|' + from);
    async function seal(payload, recipients) {
      const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(myId) }, key, te.encode(JSON.stringify(payload)));
      const keys = {};
      for (const r of recipients) keys[r.id] = toB64(await subtle.wrapKey('raw', key, await wrapKey(r.ecdh), 'AES-KW'));
      return { iv: toB64(iv), ct: toB64(ct), keys };
    }
    // Only the real sender could have wrapped a key this opens, so a message can't be forged in someone else's name
    async function open(env, fromEcdh) {
      try {
        const key = await subtle.unwrapKey('raw', fromB64(env.key), await wrapKey(fromEcdh), 'AES-KW', 'AES-GCM', false, ['decrypt']);
        const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(env.from) }, key, fromB64(env.ct));
        return JSON.parse(td.decode(pt));
      } catch (e) { return null; }
    }
    return { seal, open };
  }

  return {
    PUB, SIG, WRAPPED, IV, MAX_NAME, MAX_TEXT, ID_RE, USERNAME_RE, toB64, fromB64, isB64, canon, cleanName, randomHex,
    generateKeys, sign, verify, idOf, safetyNumber, ownerCert, makeInvite, acceptInvite, verifyCert, isRemoved,
    signRemovals, checkRemovals, createBox,
  };
});
