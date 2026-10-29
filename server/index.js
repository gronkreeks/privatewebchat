// Hush relay server. Render serves it over HTTPS/WSS on port 443 (wss://<name>.onrender.com).
// It relays end-to-end encrypted envelopes between the members of one invite-only network. It never
// sees message text, room names or who is in which room: only who an envelope is from and to.
// Membership is proven with certificates that members' apps hold (app/ui/protocol.js), so
// the server keeps nothing on disk. Members' apps re-upload what it needs when they connect, and
// a restart only loses envelopes still waiting for offline members. Set DATA_DIR to a Render disk
// to keep those too.
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
const QUEUE_TTL = 14 * 24 * 3600000;       // dropped after 14 days
const MAX_RECIPIENTS = 500, MAX_CT = 96000, MAX_DIR = 2000;
const AUTH_TIMEOUT_MS = 20000;

const ownerOk = P.isB64(OWNER_KEY, P.PUB, P.PUB);
const members = new Map();      // id -> { cert, info }
const invitesUsed = new Map();  // invite key -> id of the member who used it
const certCache = new Map();    // hash of a cert -> verified info
const online = new Map();       // id -> ws
const queues = new Map();       // id -> [envelope]
let removals = { v: 0, ids: [] }, removed = new Set();
let envSeq = 0;

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
// Adds someone to the directory. Each invite works once and usernames are unique (ignoring case):
// a second person using an invite, or a newer member taking an existing name, is turned away.
// Returns the member's info, or { why } when they're refused.
async function admit(cert) {
  const info = await checkCert(cert);
  if (!info || P.isRemoved(info, removed)) return { why: 'member' };
  const known = members.get(info.id);
  if (known) return known.info;
  const lower = info.name.toLowerCase();
  for (const x of members.values()) if (x.info.name.toLowerCase() === lower && x.info.at <= info.at) return { why: 'name' };
  if (info.ik) {
    const other = invitesUsed.get(info.ik);
    if (other && other !== info.id) return { why: 'member' };
    invitesUsed.set(info.ik, info.id);
  }
  members.set(info.id, { cert, info });
  broadcast({ t: 'member', cert }, info.id);
  save();
  return info;
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
  if (m.t === 'auth') {
    if (ws.member) return;
    if (!ownerOk) return deny(ws, 'This server has not been set up yet: it needs its OWNER_KEY.', 'setup');
    if (m.removals) await applyRemovals(m.removals);
    const info = await admit(m.cert);
    if (info.why === 'name') return deny(ws, 'That username is already taken.', 'name');
    if (info.why) return deny(ws, "This device isn't a member of this network. It may have been removed, or its invite was already used.", 'member');
    if (!(await P.verify(info.sig, ['hush-auth', ws.nonce], m.sig))) return deny(ws, "Couldn't confirm this device's identity.", 'auth');
    clearTimeout(ws.authT);
    if (Array.isArray(m.dir)) for (const c of m.dir.slice(0, MAX_DIR)) await admit(c);
    const old = online.get(info.id);
    if (old && old !== ws) { send(old, { t: 'replaced' }); old.close(4001, 'replaced'); }
    ws.member = info; online.set(info.id, ws);
    send(ws, {
      t: 'welcome', id: info.id, dir: [...members.values()].map(x => x.cert),
      removals: removals.v ? removals : null, online: [...online.keys()],
    });
    broadcast({ t: 'presence', id: info.id, on: true }, info.id);
    for (const env of queues.get(info.id) || []) send(ws, env);
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
      for (const id of to) deliver(id, { t: 'env', eid: (++envSeq).toString(36) + '.' + crypto.randomBytes(3).toString('hex'), from: me.id, iv: m.iv, ct: m.ct, key: m.keys[id], at: t });
      send(ws, { t: 'sent', ref: m.ref, at: t, n: to.length });
      if (to.length) save();
      break;
    }
    case 'ack': ack(me.id, m.eids); break;
    case 'removals': await applyRemovals(m.removals); break;
  }
}
function deny(ws, msg, why) { send(ws, { t: 'denied', msg, why }); ws.close(4000, why); }

// ──────────── Optional disk (DATA_DIR) ────────────
let saveT = null;
function save() {
  if (!DATA_DIR || saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    const file = path.join(DATA_DIR, 'hush-state.json');
    const state = { removals, members: [...members.values()].map(x => x.cert), queues: [...queues] };
    fs.writeFile(file + '.tmp', JSON.stringify(state), e => {
      if (e) return log('save failed', e.message);
      fs.rename(file + '.tmp', file, e2 => { if (e2) log('save failed', e2.message); });
    });
  }, 2000);
}
async function load() {
  if (!DATA_DIR || !ownerOk) return;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'hush-state.json'), 'utf8'));
    if (state.removals) await applyRemovals(state.removals);
    for (const c of state.members || []) await admit(c);
    const t = now();
    for (const [id, q] of state.queues || []) if (members.has(id)) queues.set(id, q.filter(e => t - e.at < QUEUE_TTL));
    log(`loaded ${members.size} members and ${queues.size} queues from disk`);
  } catch (e) { if (e.code !== 'ENOENT') log('load failed', e.message); }
}

// ──────────── HTTP + WebSocket ────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, setUp: ownerOk, online: online.size }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hush relay is running.\n');
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
  send(ws, { t: 'hello', v: 1, nonce: ws.nonce, net: ownerOk ? OWNER_KEY : null });
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
    const left = q.filter(e => t - e.at < QUEUE_TTL);
    if (left.length) queues.set(id, left); else queues.delete(id);
  }
}, 3600000).unref();

load().then(() => server.listen(PORT, () => log(`Hush relay on port ${PORT}${ownerOk ? '' : ' (not set up: OWNER_KEY is missing)'}`)));
