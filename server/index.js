// privatewebchat relay server. Render serves it over HTTPS/WSS on port 443 (wss://<name>.onrender.com).
// It relays end-to-end encrypted envelopes between the members of one invite-only network. It never
// sees message text, room names or who is in which room: only who an envelope is from and to.
// Membership is proven with certificates that members' apps hold (app/ui/protocol.js), so
// the server keeps nothing on disk. Members' apps re-upload what it needs when they connect.
// Messages only last while the server is running: a restart drops every queued envelope, and the
// apps delete their copies when they see the new boot id. Set DATA_DIR to a Render disk to keep the
// member list across restarts (never the queues).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('../app/ui/protocol.js');

const PORT = process.env.PORT || 8080;
const OWNER_KEY = (process.env.OWNER_KEY || '').trim();
const DATA_DIR = process.env.DATA_DIR || '';
const MAX_CLIENTS = +process.env.MAX_CLIENTS || 200;
const QUEUE_MAX = 2000;                    // envelopes waiting per member
const QUEUE_TTL = 14 * 24 * 3600000;       // dropped after 14 days, or sooner if the sender asks (DMs: 24 hours)
const live = (e, t) => t < (e.exp || e.at + QUEUE_TTL);
const MAX_RECIPIENTS = 500, MAX_CT = 96000, MAX_DIR = 2000;
const AUTH_TIMEOUT_MS = 20000;
// Apps from before 1.1.5 can't update themselves and don't say their version. Once a release that
// updates itself is out (the server asks GitHub every half hour), they're turned away with a message
// saying where to get it; it shows as a banner across the top of the old app. Until then they're only
// told about it, in their message box, when they connect and at most every 10 minutes when they send.
const RELEASES_URL = process.env.RELEASES_URL ?? 'https://api.github.com/repos/gronkreeks/privatewebchat/releases/latest';
const SELF_UPDATING = [1, 1, 5];
let latest = null;   // the newest release's version, once it updates itself
const OUTDATED = 'A new version of privatewebchat is out. Download it from github.com/gronkreeks/privatewebchat/releases/latest. After that, privatewebchat updates itself whenever it opens.';
const OUTDATED_EVERY = 10 * 60000;
const tooOld = name => `privatewebchat ${latest} is out and this version no longer works. Download it from github.com/gronkreeks/privatewebchat/releases/latest and open it. You'll still be ${name}, with the same PIN and friends, so you don't need an invite code. After this it updates itself.`;
async function checkLatest() {
  if (!RELEASES_URL) return;
  try {
    const r = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'privatewebchat-relay' }, signal: AbortSignal.timeout(10000) });
    const m = r.ok && /^v(\d+)\.(\d+)\.(\d+)$/.exec((await r.json()).tag_name);
    if (!m) return;
    const v = m.slice(1).map(Number), d = v.map((x, i) => x - SELF_UPDATING[i]).find(x => x);
    if ((d || 0) >= 0) latest = v.join('.');
  } catch { }
}

const ownerOk = P.isB64(OWNER_KEY, P.PUB, P.PUB);
const members = new Map();      // id -> { cert, info, vouched }
const certCache = new Map();    // hash of a cert -> verified info
const online = new Map();       // id -> ws
const queues = new Map();       // id -> [envelope]
let removals = { v: 0, ids: [] }, removed = new Set();
let envSeq = 0;
// Changes on every start, so apps know queued envelopes were lost and resend what wasn't confirmed
const BOOT = crypto.randomBytes(8).toString('hex');

const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }
function broadcast(msg, except) { const s = JSON.stringify(msg); for (const [id, ws] of online) if (id !== except) send(ws, s); }

// ──────────── Membership ────────────
async function checkCert(cert) {
  let key;
  try { key = crypto.createHash('sha256').update(P.canon(cert)).digest('hex'); } catch { return null; }
  if (certCache.has(key)) return certCache.get(key);
  const info = await P.verifyCert(cert, OWNER_KEY);
  if (info) { certCache.set(key, info); if (certCache.size > 5000) certCache.delete(certCache.keys().next().value); }
  return info;
}
// Adds someone to the directory. Usernames (ignoring case) and invites belong to whoever had them
// first: a newer member taking an existing name, or a second person using an invite, is turned away.
// The join time in a cert is picked by the joiner's app, so it can't decide who was first. After a
// restart the server only knows who has reconnected, so a holder that no other member's app knows
// gives way to an established member (one another app uploaded, a `voucher`) with the same name.
// Returns the member's info, or { why } when they're refused.
async function admit(cert, voucher) {
  const info = await checkCert(cert);
  // The owner key only signs invites and removals (tools/owner.js); it never joins as a member
  if (!info || !info.by || P.isRemoved(info, removed)) return { why: 'member' };
  const vouched = !!voucher && voucher !== info.id;
  const known = members.get(info.id);
  if (known) { if (vouched) known.vouched = true; return known.info; }
  const lower = info.name.toLowerCase();
  for (const x of [...members.values()]) {
    const sameInvite = x.info.ik === info.ik;
    if (!sameInvite && x.info.name.toLowerCase() !== lower) continue;
    if (x.vouched || !vouched) return { why: sameInvite ? 'member' : 'name' };
    drop(x.info.id);
  }
  members.set(info.id, { cert, info, vouched });
  broadcast({ t: 'member', cert }, info.id);
  save();
  return info;
}
function drop(id) {
  members.delete(id); queues.delete(id);
  const ws = online.get(id);
  if (ws) { online.delete(id); deny(ws, 'That username belongs to someone else in this network.', 'name'); }
  log(`member ${id.slice(0, 8)} gave way to an established member`);
}
async function applyRemovals(r) {
  const ok = await P.checkRemovals(r, OWNER_KEY);
  if (!ok || ok.v <= removals.v) return;
  removals = ok; removed = new Set(ok.ids);
  for (const [id, x] of members) {
    if (!P.isRemoved(x.info, removed)) continue;
    members.delete(id); queues.delete(id);
    const ws = online.get(id);
    if (ws) { send(ws, { t: 'removed' }); ws.close(4003, 'removed'); online.delete(id); }
    log(`member ${id.slice(0, 8)} removed`);
  }
  broadcast({ t: 'removals', removals });
  save();
}

// ──────────── Envelopes ────────────
function deliver(id, env) {
  let q = queues.get(id);
  if (!q) queues.set(id, q = []);
  q.push(env);
  if (q.length > QUEUE_MAX) q.shift();
  send(online.get(id), env);
}
// Envelopes stay queued until the recipient's app says it has saved them
function ack(id, eids) {
  const q = queues.get(id);
  if (!q || !Array.isArray(eids)) return;
  const done = new Set(eids.map(String));
  const left = q.filter(e => !done.has(e.eid));
  if (left.length) queues.set(id, left); else queues.delete(id);
  save();
}
function newRate() { return { times: [] }; }
function limited(st, t) {
  st.times = st.times.filter(x => t - x < 10000);
  if (st.times.length >= 40) return true;
  st.times.push(t);
  return false;
}

// ──────────── Connections ────────────
async function handle(ws, m) {
  // Owner requests (tools/owner.js) are signed with the owner key, so they need no login
  if (m.t === 'removals') return applyRemovals(m.removals);
  if (m.t === 'owner') {
    if (!ownerOk || !(await P.verify(OWNER_KEY, ['pwc-owner', ws.nonce], m.sig))) return send(ws, { t: 'denied', msg: 'Not the owner', why: 'owner' });
    return send(ws, { t: 'owner_dir', dir: [...members.values()].map(x => x.cert), removals: removals.v ? removals : null, online: [...online.keys()] });
  }
  if (m.t === 'auth') {
    if (ws.member) return;
    if (!ownerOk) return deny(ws, 'This server has not been set up yet: it needs its OWNER_KEY.', 'setup');
    if (m.removals) await applyRemovals(m.removals);
    const self = await checkCert(m.cert);
    if (!self || !self.by || P.isRemoved(self, removed)) return deny(ws, "This device isn't a member of this network. It may have been removed, or its invite was already used.", 'member');
    if (!(await P.verify(self.sig, ['pwc-auth', ws.nonce], m.sig))) return deny(ws, "Couldn't confirm this device's identity.", 'auth');
    // The members this app already knows go in first, so established members keep their names after a restart
    if (Array.isArray(m.dir)) for (const c of m.dir.slice(0, MAX_DIR)) await admit(c, self.id);
    const info = await admit(m.cert);
    if (info.why === 'name') return deny(ws, 'That username is already taken.', 'name');
    if (info.why) return deny(ws, "This device isn't a member of this network. It may have been removed, or its invite was already used.", 'member');
    if (typeof m.v !== 'string' && latest) return deny(ws, tooOld(info.name), 'outdated');
    if (ws.readyState !== 1) return;
    clearTimeout(ws.authT);
    const old = online.get(info.id);
    if (old && old !== ws) { send(old, { t: 'replaced' }); old.close(4001, 'replaced'); }
    ws.member = info; online.set(info.id, ws);
    ws.version = typeof m.v === 'string' ? m.v.slice(0, 20) : null;
    send(ws, {
      t: 'welcome', id: info.id, dir: [...members.values()].map(x => x.cert),
      removals: removals.v ? removals : null, online: [...online.keys()],
    });
    broadcast({ t: 'presence', id: info.id, on: true }, info.id);
    outdated(ws);
    const t0 = now();
    for (const env of queues.get(info.id) || []) if (live(env, t0)) send(ws, env);
    return;
  }
  const me = ws.member;
  if (!me) return;
  switch (m.t) {
    case 'send': {
      const t = now();
      if (limited(ws.rate, t)) return send(ws, { t: 'error', ref: m.ref, msg: "You're sending messages too fast. Wait a few seconds." });
      if (!P.isB64(m.iv, P.IV, P.IV) || !P.isB64(m.ct, 24, MAX_CT) || !m.keys || typeof m.keys !== 'object') return send(ws, { t: 'error', ref: m.ref, msg: "That message couldn't be sent" });
      const to = Object.keys(m.keys).slice(0, MAX_RECIPIENTS).filter(id => id !== me.id && members.has(id) && P.isB64(m.keys[id], P.WRAPPED, P.WRAPPED));
      const ttl = Number.isFinite(m.ttl) ? Math.max(1000, Math.min(QUEUE_TTL, m.ttl)) : QUEUE_TTL;
      for (const id of to) deliver(id, { t: 'env', eid: (++envSeq).toString(36) + '.' + crypto.randomBytes(3).toString('hex'), from: me.id, iv: m.iv, ct: m.ct, key: m.keys[id], at: t, exp: t + ttl });
      send(ws, { t: 'sent', ref: m.ref, at: t, n: to.length });
      if (to.length) save();
      outdated(ws);
      break;
    }
    case 'ack': ack(me.id, m.eids); break;
  }
}
function outdated(ws) {
  const t = now();
  if (ws.version || latest || t - (ws.toldOutdated || 0) < OUTDATED_EVERY) return;
  ws.toldOutdated = t;
  send(ws, { t: 'error', msg: OUTDATED });
}
function deny(ws, msg, why) { send(ws, { t: 'denied', msg, why }); ws.close(4000, why); }

// ──────────── Optional disk (DATA_DIR) ────────────
let saveT = null;
function save() {
  if (!DATA_DIR || saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    const file = path.join(DATA_DIR, 'pwc-state.json');
    const state = { removals, members: [...members.values()].map(x => x.cert) };
    fs.writeFile(file + '.tmp', JSON.stringify(state), e => {
      if (e) return log('save failed', e.message);
      fs.rename(file + '.tmp', file, e2 => { if (e2) log('save failed', e2.message); });
    });
  }, 2000);
}
async function load() {
  if (!DATA_DIR || !ownerOk) return;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pwc-state.json'), 'utf8'));
    if (state.removals) await applyRemovals(state.removals);
    for (const c of state.members || []) await admit(c, 'disk');
    log(`loaded ${members.size} members from disk`);
  } catch (e) { if (e.code !== 'ENOENT') log('load failed', e.message); }
}

// ──────────── HTTP + WebSocket ────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, setUp: ownerOk, online: online.size }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('privatewebchat relay is running.\n');
});
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });
wss.on('connection', ws => {
  if (wss.clients.size > MAX_CLIENTS) { ws.close(1013, 'busy'); return; }
  ws.isAlive = true; ws.rate = newRate();
  ws.nonce = crypto.randomBytes(32).toString('base64');
  ws.authT = setTimeout(() => ws.close(4000, 'auth timeout'), AUTH_TIMEOUT_MS);
  let queue = Promise.resolve();
  ws.on('pong', () => { ws.isAlive = true; });
  // Messages are handled one at a time, in order, because checking signatures is asynchronous
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    queue = queue.then(() => handle(ws, m)).catch(e => log('error', e));
  });
  ws.on('close', () => {
    clearTimeout(ws.authT);
    const me = ws.member;
    if (me && online.get(me.id) === ws) { online.delete(me.id); broadcast({ t: 'presence', id: me.id, on: false }); }
  });
  send(ws, { t: 'hello', v: 1, boot: BOOT, nonce: ws.nonce, net: ownerOk ? OWNER_KEY : null });
});
// Render's proxy drops quiet connections, so ping every 25 seconds
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25000);
setInterval(() => {
  const t = now();
  for (const [id, q] of queues) {
    const left = q.filter(e => live(e, t));
    if (left.length) queues.set(id, left); else queues.delete(id);
  }
}, 10 * 60000).unref();

checkLatest();
setInterval(checkLatest, 30 * 60000).unref();
load().then(() => server.listen(PORT, () => log(`privatewebchat relay on port ${PORT}${ownerOk ? '' : ' (not set up: OWNER_KEY is missing)'}`)));
