#!/usr/bin/env node
// Owner tool for privatewebchat: the only place invite codes are made and people are removed.
// The owner key never leaves this computer. It lives in ~/.privatewebchat/owner.json (keep a
// backup somewhere safe: without it you can't invite or remove anyone).
//
//   node tools/owner.js init                  make the owner key and print OWNER_KEY for Render
//   node tools/owner.js key                   print OWNER_KEY again
//   node tools/owner.js invite [count] [days] print invite codes (default 1 code, valid 90 days)
//   node tools/owner.js members               list everyone on the server
//   node tools/owner.js remove <username>     remove someone from the server
//
// Needs Node 22+. Talks to the server in app/ui/config.js (or the SERVER environment variable).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../app/ui/protocol.js');
const SERVER = process.env.SERVER || require('../app/ui/config.js').SERVER;
const DIR = process.env.PWC_OWNER_DIR || path.join(os.homedir(), '.privatewebchat');
const FILE = path.join(DIR, 'owner.json');

const die = msg => { console.error(msg); process.exit(1); };
function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { die(`No owner key yet (${FILE}). Run: node tools/owner.js init`); }
}
const encodeInvite = inv => 'PWC1.' + Buffer.from(JSON.stringify(inv)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Opens a connection, proves we hold the owner key, and returns the member list and removals
function ownerSession(owner) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(SERVER);
    const t = setTimeout(() => { ws.close(); rej(new Error(`No answer from ${SERVER} (a sleeping Render server can take a minute; try again)`)); }, 90000);
    ws.onerror = () => { clearTimeout(t); rej(new Error(`Couldn't reach ${SERVER}`)); };
    ws.onmessage = async e => {
      const m = JSON.parse(e.data);
      if (m.t === 'hello') {
        if (m.net !== owner.keys.sigPub) { clearTimeout(t); ws.close(); return rej(new Error(m.net ? "The server's OWNER_KEY is a different key." : 'The server has no OWNER_KEY yet. Add it in Render (node tools/owner.js key).')); }
        ws.send(JSON.stringify({ t: 'owner', sig: await P.sign(owner.keys.sigPriv, ['pwc-owner', m.nonce]) }));
      } else if (m.t === 'owner_dir') { clearTimeout(t); res({ ws, dir: m.dir, removals: m.removals, online: new Set(m.online) }); }
      else if (m.t === 'denied') { clearTimeout(t); ws.close(); rej(new Error(m.msg)); }
    };
  });
}
async function members(owner, session) {
  const list = [];
  for (const c of session.dir) { const i = await P.verifyCert(c, owner.keys.sigPub); if (i) list.push(i); }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'init') {
    if (fs.existsSync(FILE)) die(`There's already an owner key in ${FILE}. Delete it first if you really want a new network (everyone will need new invites).`);
    const keys = await P.generateKeys();
    const cert = await P.ownerCert(keys, 'developer');
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(FILE, JSON.stringify({ keys, cert, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log(`Owner key saved to ${FILE}. Back this file up somewhere safe.\n`);
    console.log('In Render, open your service → Environment → add this variable, then save and deploy:\n');
    console.log(`  OWNER_KEY = ${keys.sigPub}\n`);
  } else if (cmd === 'key') {
    console.log(load().keys.sigPub);
  } else if (cmd === 'invite') {
    const owner = load();
    const count = Math.max(1, Math.min(200, parseInt(args[0] || '1', 10) || 1));
    const days = Math.max(1, Math.min(3650, parseFloat(args[1] || '90') || 90));
    for (let i = 0; i < count; i++) {
      const inv = await P.makeInvite(owner.cert, owner.keys, days * 24);
      console.log(encodeInvite({ g: inv.g, k: inv.k }));
      if (i < count - 1) console.log('');
    }
    console.error(`\n${count} invite code${count > 1 ? 's' : ''}, each works once and expires in ${days} days.`);
  } else if (cmd === 'members') {
    const owner = load();
    const s = await ownerSession(owner);
    const list = await members(owner, s);
    s.ws.close();
    if (!list.length) console.log('Nobody has joined yet.');
    for (const i of list) console.log(`${s.online.has(i.id) ? '●' : '○'} ${i.name}`);
  } else if (cmd === 'remove') {
    const owner = load();
    const name = (args[0] || '').toLowerCase();
    if (!name) die('Usage: node tools/owner.js remove <username>');
    const s = await ownerSession(owner);
    const target = (await members(owner, s)).find(i => i.name.toLowerCase() === name);
    if (!target) { s.ws.close(); die(`Nobody called ${args[0]} is on the server.`); }
    const prev = s.removals || { v: 0, ids: [] };
    const r = await P.signRemovals(owner.keys, prev.v + 1, [...new Set([...prev.ids, target.id])]);
    s.ws.send(JSON.stringify({ t: 'removals', removals: r }));
    await new Promise(res => setTimeout(res, 500));
    s.ws.close();
    console.log(`Removed ${target.name}. They've been disconnected and their invite no longer works.`);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
})().catch(e => die(e.message));
