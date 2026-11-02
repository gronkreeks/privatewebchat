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

  // ── Short invite codes ──
  // PWC2.<16-byte seed><expiry in minutes, 4 bytes><owner's signature, 64 bytes>, base64url: 117
  // characters instead of the 1000 of a PWC1 code. The invite key pair comes from the seed, and the
  // owner's certificate comes from the app (config.js), so the code doesn't carry either. Accepting
  // one gives exactly the same certificate as a PWC1 code.
  const INVITE2 = 'PWC2.';
  const b64url = bytes => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fromB64url = s => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  // A P-256 private key in PKCS#8 without its public half (WebCrypto works that out on import)
  const PKCS8_HEAD = [0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20];
  async function inviteKey(seed) {
    const h = new Uint8Array(await subtle.digest('SHA-256', new Uint8Array([...te.encode('pwc-invite-key|'), ...seed])));
    const d = BigInt('0x' + hex(h)) % (P256_N - 1n) + 1n;
    const pkcs8 = new Uint8Array([...PKCS8_HEAD, ...(d.toString(16).padStart(64, '0').match(/../g).map(x => parseInt(x, 16)))]);
    const jwk = await subtle.exportKey('jwk', await subtle.importKey('pkcs8', pkcs8, ECDSA, true, ['sign']));
    return { ik: toB64(new Uint8Array([4, ...fromB64url(jwk.x), ...fromB64url(jwk.y)])), k: toB64(pkcs8) };
  }
  // ownerPriv is the owner's signing key (PKCS#8, base64). Expiry is rounded to the minute.
  async function makeShortInvite(ownerPriv, hours) {
    const seed = crypto.getRandomValues(new Uint8Array(16));
    const mins = Math.floor((Date.now() + hours * 3600000) / 60000);
    const { ik } = await inviteKey(seed);
    const s = fromB64(await sign(ownerPriv, ['pwc-invite', ik, mins * 60000]));
    return INVITE2 + b64url(new Uint8Array([...seed, mins >>> 24, (mins >>> 16) & 255, (mins >>> 8) & 255, mins & 255, ...s]));
  }
  // The same { g, k } a PWC1 code holds, or null. ownerCert is the owner's certificate from config.js.
  async function readShortInvite(code, ownerCert) {
    const s = String(code || '').replace(/\s+/g, '');
    if (!s.startsWith(INVITE2) || !ownerCert || !/^[A-Za-z0-9_-]{112}$/.test(s.slice(INVITE2.length))) return null;
    const b = fromB64url(s.slice(INVITE2.length));
    const exp = (b[16] * 2 ** 24 + (b[17] << 16) + (b[18] << 8) + b[19]) * 60000;
    const { ik, k } = await inviteKey(b.slice(0, 16));
    return { g: { ik, exp, from: ownerCert, s: toB64(b.slice(20)) }, k };
  }

  // ── Spoken invite codes ──
  // 12 digits, short enough to say out loud. They stand for an ordinary invite code, encrypted with a
  // key that only the 12 digits give (PBKDF2, slow on purpose: guessing a code takes years of computing,
  // and they expire after a few days). The owner signs the encrypted copy; the server keeps it and
  // hands every copy it has to anyone who asks, and members' apps keep them and hand them back after
  // a restart, like announcements. The app that's joining tries its key on each.
  const SPOKEN_ITER = 2000000;
  const spokenDigits = s => String(s == null ? '' : s).replace(/[\s.-]/g, '');
  const isSpoken = s => /^\d{12}$/.test(spokenDigits(s));
  const fmtSpoken = s => spokenDigits(s).replace(/(\d{4})(?=\d)/g, '$1 ');
  async function spokenKey(code, owner) {
    const base = await subtle.importKey('raw', te.encode(spokenDigits(code)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: te.encode('pwc-spoken|' + owner), iterations: SPOKEN_ITER },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const spokenAad = (id, exp) => te.encode('pwc-spoken|' + id + '|' + exp);
  // inviteCode is a PWC2. or PWC1. code; owner is the owner's public key. Returns { code, entry }.
  async function makeSpoken(ownerPriv, owner, inviteCode, hours) {
    let code = '';
    while (code.length < 12) for (const x of crypto.getRandomValues(new Uint8Array(16))) if (x < 250 && code.length < 12) code += x % 10;
    const id = randomHex(8), exp = Date.now() + Math.round(hours * 3600000), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = toB64(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: spokenAad(id, exp) }, await spokenKey(code, owner), te.encode(inviteCode)));
    return { code, entry: { id, exp, iv: toB64(iv), ct, s: await sign(ownerPriv, ['pwc-spoken', id, exp, toB64(iv), ct]) } };
  }
  async function checkSpoken(e, owner) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ANN_ID.test(e.id) || !Number.isSafeInteger(e.exp) ||
      !isB64(e.iv, IV, IV) || !isB64(e.ct, 24, 2400)) return null;
    return (await verify(owner, ['pwc-spoken', e.id, e.exp, e.iv, e.ct], e.s)) ? { id: e.id, exp: e.exp, iv: e.iv, ct: e.ct, s: e.s } : null;
  }
  // The invite code a spoken code stands for, from entries already checked with checkSpoken, or null
  async function openSpoken(code, owner, entries) {
    const key = await spokenKey(code, owner);
    for (const e of entries) {
      try { return td.decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.iv), additionalData: spokenAad(e.id, e.exp) }, key, fromB64(e.ct))); } catch (x) { }
    }
    return null;
  }

  // ── Announcements ──
  // Posts in Announcements are signed with the owner key (only the developer can post) and aren't
  // encrypted: everyone in the network reads them. Each app keeps them and hands them to the server
  // when it connects, like removals, so they outlive server restarts. A post with empty text deletes
  // the one with that id; the newest version of an id wins.
  const MAX_ANN = 6000, ANN_ID = /^[0-9a-f]{16}$/;
  async function signAnn(ownerPriv, id, at, text) { return { id, at, text, s: await sign(ownerPriv, ['pwc-ann', id, at, text]) }; }
  async function checkAnn(a, owner) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !ANN_ID.test(a.id) || !Number.isSafeInteger(a.at) || a.at < 0 ||
      typeof a.text !== 'string' || a.text.length > MAX_ANN) return null;
    return (await verify(owner, ['pwc-ann', a.id, a.at, a.text], a.s)) ? { id: a.id, at: a.at, text: a.text, s: a.s } : null;
  }

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
    signRemovals, checkRemovals, createBox, INVITE2, makeShortInvite, readShortInvite, MAX_ANN, signAnn, checkAnn,
    isSpoken, fmtSpoken, makeSpoken, checkSpoken, openSpoken,
  };
});
