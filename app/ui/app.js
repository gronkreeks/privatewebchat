// privatewebchat app. Screens, the connection to the relay, friends, chats, settings, the black-out key and
// the wipe PIN. Nothing about chats is stored on the server: General is everyone, direct messages
// are between two friends, and a group chat's name and members travel inside its encrypted messages.
// Friend requests are encrypted messages too.
(() => {
  'use strict';
  const P = PwcProto;
  const $ = id => document.getElementById(id);
  const MAX_HISTORY = 3000, SHOWN = 400;
  const DM_TTL = 24 * 3600000;   // direct messages are deleted after 24 hours, for privacy and to save space

  let D = null;        // the unlocked vault (Vault.data)
  const S = {
    info: {},           // member id -> verified certificate info
    removed: new Set(),
    online: new Set(),
    box: null, unlocked: false, black: false, capturing: false,
    view: 'friends',    // 'friends' or a chat id
    ftab: 'online', status: 'offline', live: false,
  };

  // ──────────── Little helpers ────────────
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v;   // the CSP blocks style attributes, but not this
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : String(k));
    return e;
  }
  const screens = ['sWelcome', 'sSetPin', 'sUnlock', 'sGone', 'sMain'];
  function show(id) { for (const s of screens) $(s).classList.toggle('hidden', s !== id); const f = $(id).querySelector('input, textarea'); if (f) setTimeout(() => f.focus(), 30); }
  const err = (id, t, ok) => { $(id).textContent = t || ''; $(id).classList.toggle('ok', !!ok); };
  const hue = s => { let x = 0; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
  const digitsOnly = el => el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, ''); });
  const validPin = p => /^\d{4,12}$/.test(p);
  const nameOf = id => (S.info[id] && S.info[id].name) || (D && D.names[id]) || 'someone';
  const isFriend = id => D.friends[id] === 'friend';
  const isOnline = id => S.online.has(id) || (id === D.me && S.status === 'online');
  const copy = t => window.pwc_copy(t);
  const native = {
    title: t => window.pwc_title(t),
    attention: () => window.pwc_attention(),
    panic: (code, on) => window.pwc_set_panic(code, on),
    notify: (title, body) => window.pwc_notify(title, body),
  };
  function fmtTime(at) {
    const d = new Date(at), t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + t;
  }
  function keyLabel(code) {
    if (!code) return 'none';
    if (code === 'Escape') return 'Esc';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const map = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };
    return map[code] || code;
  }
  // A coloured circle with the first letter of the name, and an online dot for people
  function avatar(id, size, dot) {
    const n = nameOf(id);
    return h('span', { class: 'av' + (size ? ' ' + size : ''), style: `--h: ${hue(n)}` }, n[0],
      dot ? h('span', { class: 'st' + (isOnline(id) ? ' on' : '') }) : null);
  }
  const groupAvatar = (r, size) => h('span', { class: 'av group' + (size ? ' ' + size : ''), style: `--h: ${hue(r.name)}` }, r.name[0]);

  // ──────────── Themes ────────────
  // Saved beside the vault (not inside it), so the lock screen already has your theme
  const THEMES = [
    { id: 'kali', name: 'Kali', desc: 'Black and white', bg: '#000000', fg: '#ededed', a: '#367bf0', b: '#ffffff', mono: false, prompt: true },
    { id: 'matrix', name: 'Matrix', desc: 'Green on black', bg: '#000000', fg: '#00ff41', a: '#00ff41', b: '#7dffa0', mono: true, prompt: true },
    { id: 'amber', name: 'Amber', desc: 'Retro amber', bg: '#0c0800', fg: '#ffb000', a: '#ffb000', b: '#ffd166', mono: true, prompt: true },
    { id: 'midnight', name: 'Midnight', desc: 'Navy and gold', bg: '#0f1e3d', fg: '#ffffff', a: '#27ae60', b: '#f5c518', mono: false, prompt: false },
  ];
  function applyTheme(id) { document.documentElement.dataset.theme = THEMES.some(t => t.id === id) ? id : 'kali'; }
  function themePicker() {
    const cur = document.documentElement.dataset.theme;
    const cards = THEMES.map(t => h('button', {
      class: 'theme-card' + (t.id === cur ? ' on' : ''), onclick: async () => {
        applyTheme(t.id);
        for (const c of cards) c.classList.toggle('on', c === cards[THEMES.indexOf(t)]);
        try { await Vault.setTheme(t.id); } catch (e) { }
      },
    }, h('div', { class: 'sw', style: `background:${t.bg};color:${t.fg};border:1px solid ${t.a}55;font-family:${t.mono ? 'ui-monospace,Menlo,Consolas,monospace' : '-apple-system,"Segoe UI",system-ui,sans-serif'}` },
      h('div', { style: `color:${t.a};font-weight:700;font-family:ui-monospace,Menlo,Consolas,monospace` }, t.prompt ? '┌──(you㉿pwc)-[~]' : '# General'),
      h('div', {}, h('span', { style: `color:${t.b};font-weight:700` }, t.mono ? '<maya> ' : 'maya '), 'see you there'),
      h('div', { style: `color:${t.a};font-family:ui-monospace,Menlo,Consolas,monospace` }, t.prompt ? '└─$' : '')),
    h('div', { class: 'tn' }, t.name, h('small', { text: t.desc }))));
    return h('div', { class: 'themes' }, cards);
  }

  // ──────────── Modal ────────────
  function modal(title, ...body) {
    const card = $('modalCard');
    card.innerHTML = '';
    card.dataset.kind = '';
    card.append(title ? h('h2', { text: title }) : '', ...body.filter(x => x != null && x !== false));
    $('modal').classList.remove('hidden');
    const f = card.querySelector('input:not([type=checkbox]), textarea');
    if (f) setTimeout(() => f.focus(), 30);
  }
  function closeModal() { $('modal').classList.add('hidden'); $('modalCard').innerHTML = ''; S.capturing = false; }
  $('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) closeModal(); });
  function ask(title, text, yes, fn, danger) {
    modal(title, h('p', { class: 'hint', text }),
      h('div', { class: 'row end' }, h('button', { class: 'link', onclick: closeModal }, 'Cancel'),
        h('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => { closeModal(); fn(); } }, yes)));
  }
  const closeBtn = () => h('div', { class: 'row end' }, h('button', { class: 'link', onclick: closeModal }, 'Close'));

  // ──────────── Start-up ────────────
  async function boot() {
    try { await Vault.load(); } catch (e) { return gone("privatewebchat couldn't start", "It couldn't read its data folder."); }
    applyTheme(Vault.theme);
    if (!Vault.exists) return show('sWelcome');
    try {
      if (await Vault.orphaned()) return gone("This device's data can't be opened", "privatewebchat's key for this computer is missing (for example after moving the data to another computer or Windows account), so the messages stored here can never be decrypted. Erase them to start again.");
    } catch (e) { return gone("privatewebchat couldn't read its key", 'The system keychain refused to hand over the key that protects your data. Open privatewebchat again and allow access when asked.', true); }
    show('sUnlock');
  }
  function gone(title, msg, noErase) {
    $('goneTitle').textContent = title; $('goneMsg').textContent = msg;
    $('goneErase').classList.toggle('hidden', !!noErase);
    show('sGone');
  }
  $('goneErase').onclick = () => ask('Erase this device?', 'This deletes everything privatewebchat has stored on this computer: your identity, messages and settings. It cannot be undone.', 'Erase', wipe, true);

  // ── Unlock ──
  digitsOnly($('unlockPin'));
  async function tryPin(pin, onWrong) {
    const wait = await window.pwc_pin_start();
    if (wait > 0) { onWrong(`Too many wrong PINs. Try again in ${Math.ceil(wait / 1000)} seconds.`); return null; }
    const r = S.unlocked ? await Vault.check(pin) : await Vault.unlock(pin);
    if (r === 'wipe') { await wipe(); return null; }
    await window.pwc_pin_result(r === 'ok');
    if (r !== 'ok') { onWrong('Wrong PIN'); return null; }
    return r;
  }
  async function unlock() {
    const pin = $('unlockPin').value;
    if (!pin) return;
    $('unlockGo').disabled = true; err('unlockErr', '');
    try {
      if (await tryPin(pin, m => err('unlockErr', m))) { $('unlockPin').value = ''; await start(); }
      else $('unlockPin').value = '';
    } catch (e) { err('unlockErr', "Couldn't unlock: " + e.message); }
    $('unlockGo').disabled = false;
    if (!S.unlocked) $('unlockPin').focus();
  }
  $('unlockGo').onclick = unlock;
  $('unlockPin').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });

  // ── First run ──
  // Every copy connects to the developer's server (config.js). Paste an invite code, then the
  // username box appears.
  let pending = null;   // what setup will create once a PIN is chosen
  const usernameProblem = n => n.length < 2 ? 'Usernames need at least 2 characters' : !P.USERNAME_RE.test(n) ? 'Usernames can only use letters, numbers, _ and .' : null;

  const INVITE_PREFIX = 'PWC1.';
  function parseInvite(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s.startsWith(INVITE_PREFIX)) return null;
    try {
      const json = atob(s.slice(INVITE_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/'));
      const inv = JSON.parse(decodeURIComponent(escape(json)));
      if (!inv || !inv.g || typeof inv.k !== 'string') return null;
      return inv;
    } catch (e) { return null; }
  }
  // An invite is valid when the owner signed it. Returns the owner's key, or null.
  async function checkInvite(inv) {
    const c = inv.g.from;
    const owner = c && c.m && c.m.sig;
    if (!owner || c.by) return null;
    const from = await P.verifyCert(c, owner);
    if (!from || !(await P.verify(from.sig, ['pwc-invite', inv.g.ik, inv.g.exp], inv.g.s))) return null;
    return owner;
  }
  let checked = null;   // { inv, owner } once the pasted code is valid
  $('joinCode').addEventListener('input', async () => {
    const text = $('joinCode').value;
    const inv = parseInvite(text);
    const owner = inv && await checkInvite(inv);
    if (text !== $('joinCode').value) return;   // changed while checking
    checked = owner ? { inv, owner } : null;
    const expired = checked && inv.g.exp < Date.now();
    err('joinErr', !text.trim() ? '' : !checked ? "That invite code isn't valid" : expired ? 'That invite code has expired. Ask for a new one.' : '');
    const show2 = !!checked && !expired;
    const was = !$('joinMore').classList.contains('hidden');
    $('joinMore').classList.toggle('hidden', !show2);
    $('joinRow').classList.toggle('hidden', !show2);
    if (show2 && !was) setTimeout(() => $('joinName').focus(), 0);
  });
  $('joinName').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinNext').click(); });
  $('joinName').addEventListener('input', () => err('joinErr', ''));
  $('joinNext').onclick = () => {
    if (!checked) return;
    const name = $('joinName').value.trim();
    const bad = usernameProblem(name);
    if (bad) return err('joinErr', bad);
    pending = { inv: checked.inv, owner: checked.owner, name };
    pinScreen();
  };

  digitsOnly($('newPin')); digitsOnly($('newPin2'));
  function pinScreen() { $('newPin').value = ''; $('newPin2').value = ''; err('setPinErr', ''); show('sSetPin'); }
  $('setPinBack').onclick = () => show('sWelcome');
  $('newPin2').addEventListener('keydown', e => { if (e.key === 'Enter') $('setPinGo').click(); });
  $('setPinGo').onclick = async () => {
    const a = $('newPin').value, b = $('newPin2').value;
    if (!validPin(a)) return err('setPinErr', 'Your PIN needs 4 to 12 digits');
    if (a !== b) return err('setPinErr', "Those PINs don't match");
    $('setPinGo').disabled = true; err('setPinErr', 'Setting up…', true);
    try {
      const keys = await P.generateKeys();
      const me = await P.idOf(keys.sigPub);
      const cert = await P.acceptInvite(pending.inv, keys, pending.name);
      // The invite is kept until the server accepts us, in case the username is taken and we need to pick another
      await Vault.create(a, {
        v: 1, server: PwcConfig.SERVER, owner: pending.owner, me, keys, cert, dir: { [me]: cert }, names: {}, removals: null,
        pendingInvite: { g: pending.inv.g, k: pending.inv.k },
        rooms: { general: { id: 'general', kind: 'general', name: 'General' } }, msgs: {}, unread: {},
        friends: {}, blocked: {},
        settings: { panicCode: 'Escape', panicGlobal: false, notify: true, previews: true, wipeSet: false },
      });
      await window.pwc_pin_result(true);
      pending = null;
      await start();
    } catch (e) { err('setPinErr', "Couldn't finish setting up: " + e.message); }
    $('setPinGo').disabled = false;
  };

  // ──────────── Unlocked ────────────
  async function start() {
    D = Vault.data;
    D.friends = D.friends || {}; D.blocked = D.blocked || {};
    if (D.settings.notify === undefined) { D.settings.notify = true; D.settings.previews = true; }
    S.unlocked = true;
    if (D.server !== PwcConfig.SERVER) { D.server = PwcConfig.SERVER; Vault.save(); }
    S.box = P.createBox(D.me, D.keys.ecdhPriv);
    S.removed = new Set(D.removals ? D.removals.ids : []);
    for (const c of Object.values(D.dir)) await learn(c, true);
    S.view = Object.values(D.friends).includes('friend') || Object.keys(S.info).length > 1 ? 'friends' : 'general';
    pruneDms();
    await applyPanicKey();
    try { window.pwc_notify_setup(); } catch (e) { }
    show('sMain');
    render();
    connect();
  }
  // Adds a member we've been told about, after checking their certificate ourselves
  async function learn(cert, quiet) {
    const info = await P.verifyCert(cert, D.owner);
    if (!info || !info.by || P.isRemoved(info, S.removed)) return null;
    const isNew = !S.info[info.id];
    S.info[info.id] = info;
    if (!D.dir[info.id] || D.names[info.id] !== info.name) { D.dir[info.id] = cert; D.names[info.id] = info.name; Vault.save(); }
    if (isNew && !quiet && S.live && info.id !== D.me) sysMsg('general', `${info.name} joined the network`);
    return info;
  }
  async function applyRemovals(r) {
    const ok = await P.checkRemovals(r, D.owner);
    if (!ok || (D.removals && ok.v <= D.removals.v)) return;
    D.removals = ok; S.removed = new Set(ok.ids);
    for (const [id, info] of Object.entries(S.info)) {
      if (!P.isRemoved(info, S.removed)) continue;
      if (id === D.me) { stopNet(); return gone('You were removed from this network', 'The owner removed you, so you can no longer send or receive messages here.'); }
      delete S.info[id]; delete D.dir[id]; delete D.friends[id];
    }
    Vault.save();
    render();
  }

  // ──────────── Connection ────────────
  let ws = null, retry = 1500, retryT = null, stopped = false, queue = Promise.resolve();
  const wsSend = m => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(m)); return true; } return false; };
  function setStatus(st, text, bad, action) {
    S.status = st;
    const dot = $('netDot');
    dot.className = 'dot' + (st === 'online' ? ' on' : st === 'connecting' ? ' wait' : '');
    dot.title = st === 'online' ? 'Connected' : text || 'Offline';
    const b = $('banner');
    b.innerHTML = '';
    b.classList.toggle('hidden', !text);
    b.classList.toggle('bad', !!bad);
    if (text) { b.append(h('span', { text })); if (action) b.append(action); }
    renderComposer();
  }
  function connect() {
    if (ws || stopped) return;
    clearTimeout(retryT);
    setStatus('connecting', 'Connecting… the server can take up to a minute to wake up.');
    try { ws = new WebSocket(D.server); } catch (e) { setStatus('offline', "Couldn't reach the server.", true); return; }
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch (x) { return; }
      queue = queue.then(() => onMsg(m)).catch(x => console.error(x));
    };
    ws.onclose = () => {
      ws = null; S.live = false; S.online.clear();
      failPending();
      if (stopped) return;
      if (S.status === 'online' || S.status === 'connecting') setStatus('offline', 'Disconnected. Reconnecting…', true);
      retryT = setTimeout(connect, retry);
      retry = Math.min(30000, retry * 1.6);
      renderSidebar(); if (S.view === 'friends') renderFriends();
    };
  }
  function stopNet() { stopped = true; clearTimeout(retryT); if (ws) { try { ws.close(); } catch (e) { } } ws = null; }

  async function onMsg(m) {
    switch (m.t) {
      case 'hello':
        if (m.net !== D.owner) {
          setStatus('setup', m.net ? "Your invite doesn't match this server. Ask the developer for a new one." : "The server isn't ready yet. Hang on, it keeps trying.", true);
          ws.close();
          return;
        }
        wsSend({ t: 'auth', cert: D.cert, sig: await P.sign(D.keys.sigPriv, ['pwc-auth', m.nonce]), dir: Object.values(D.dir), removals: D.removals });
        break;
      case 'welcome':
        retry = 1500;
        if (D.pendingInvite) { delete D.pendingInvite; Vault.save(); }
        if ($('modalCard').dataset.kind === 'rename') closeModal();
        if (m.removals) await applyRemovals(m.removals);
        for (const c of m.dir || []) await learn(c, true);
        S.online = new Set(m.online || []);
        S.live = true;
        setStatus('online');
        render();
        break;
      case 'member': await learn(m.cert); renderSidebar(); if (S.view === 'friends') renderFriends(); break;
      case 'presence':
        if (m.on) S.online.add(m.id); else S.online.delete(m.id);
        renderSidebar(); if (S.view === 'friends') renderFriends(); else renderHeader();
        break;
      case 'removals': await applyRemovals(m.removals); break;
      case 'env': await receive(m); break;
      case 'sent': markSent(m.ref); break;
      case 'error': markFailed(m.ref); err('chatErr', m.msg); break;
      case 'denied':
        stopNet();
        if (m.why === 'name' && D.pendingInvite) { setStatus('offline', 'That username is already taken.', true, h('button', { class: 'link', onclick: rename }, 'Pick another')); rename(); }
        else if (m.why === 'member' || m.why === 'name') gone("This device can't connect", m.msg);
        else if (m.why === 'setup') setStatus('setup', m.msg, true);
        else setStatus('offline', m.msg, true);
        break;
      case 'removed': stopNet(); gone('You were removed from this network', 'The owner removed you, so you can no longer send or receive messages here.'); break;
      case 'replaced': stopNet(); setStatus('offline', 'privatewebchat connected from somewhere else with this identity, so this window stopped.', true); break;
    }
  }
  // Someone already has the username we joined with: sign our membership again with a new one
  function rename() {
    const input = h('input', { class: 'in', maxlength: 24, spellcheck: 'false', placeholder: 'New username' });
    const e = h('div', { class: 'err' });
    const go = h('button', {
      class: 'btn', onclick: async () => {
        const name = input.value.trim(), bad = usernameProblem(name);
        if (bad) { e.textContent = bad; return; }
        go.disabled = true;
        D.cert = await P.acceptInvite(D.pendingInvite, D.keys, name);
        D.dir[D.me] = D.cert;
        await learn(D.cert, true);
        await Vault.saveNow();
        stopped = false; closeModal(); render(); connect();
      },
    }, 'Use this username');
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') go.click(); });
    modal('That username is taken', h('p', { class: 'hint', text: "Someone in this network already has it. Pick another one. You can't change it later." }), input, e, h('div', { class: 'row end' }, go));
    $('modalCard').dataset.kind = 'rename';
  }

  // ──────────── Receiving ────────────
  let acks = [], ackT = null;
  // Envelopes are acknowledged once they're saved, so nothing is lost if privatewebchat quits in between
  function ackLater(eid) {
    acks.push(eid);
    clearTimeout(ackT);
    ackT = setTimeout(async () => {
      const list = acks; acks = [];
      try { await Vault.saveNow(); wsSend({ t: 'ack', eids: list }); } catch (e) { acks.push(...list); }
    }, 300);
  }
  async function receive(env) {
    ackLater(env.eid);
    const from = S.info[env.from];
    if (!from || D.blocked[env.from]) return;
    const p = await S.box.open(env, from.ecdh);
    if (!p || typeof p !== 'object') return;
    if (p.k === 'friend') return onFriend(p.op, env.from);
    if (p.k === 'room') { applyRoom(p.room, env.from); render(); return; }
    if (p.k !== 'msg' || typeof p.text !== 'string' || !p.text.trim() || typeof p.mid !== 'string' || p.mid.length > 40) return;
    let rid;
    if (p.room === 'general') rid = 'general';
    else if (p.room === dmId(env.from)) {
      if (!isFriend(env.from) || env.at < Date.now() - DM_TTL) return;   // friends only, and never older than 24 hours
      rid = p.room; ensureDm(env.from);
    } else {
      if (p.meta) applyRoom(p.meta, env.from);
      const r = D.rooms[p.room];
      if (!r || r.kind !== 'group' || !r.members.includes(env.from)) return;
      rid = r.id;
    }
    addMsg(rid, { mid: p.mid, from: env.from, text: p.text.slice(0, P.MAX_TEXT), at: env.at });
  }
  const dmId = other => 'dm:' + [D.me, other].sort().join(':');
  const dmWith = id => id.slice(3).split(':').find(x => x !== D.me);
  function ensureDm(other) { const id = dmId(other); if (!D.rooms[id]) D.rooms[id] = { id, kind: 'dm', with: other }; return D.rooms[id]; }
  // A group chat's name and members: only a friend can add you, and only members can change it
  function applyRoom(meta, from) {
    if (!meta || typeof meta.id !== 'string' || !/^g:[0-9a-f]{32}$/.test(meta.id) || typeof meta.rv !== 'number' || !Array.isArray(meta.members)) return;
    const members = [...new Set(meta.members.filter(x => typeof x === 'string' && P.ID_RE.test(x)))].slice(0, 200);
    const name = P.cleanName(meta.name, 40);
    if (!name) return;
    const cur = D.rooms[meta.id];
    if (cur ? !cur.members.includes(from) : (!members.includes(from) || !isFriend(from))) return;
    if (cur && meta.rv <= cur.rv) return;
    if (!members.includes(D.me)) {
      if (cur) { delete D.rooms[meta.id]; delete D.msgs[meta.id]; delete D.unread[meta.id]; if (S.view === meta.id) S.view = 'friends'; Vault.save(); render(); }
      return;
    }
    D.rooms[meta.id] = { id: meta.id, kind: 'group', name, members, rv: meta.rv };
    if (!cur) { sysMsg(meta.id, `${nameOf(from)} added you to ${name}`); notify(name, `${nameOf(from)} added you to a group chat`); }
    else if (cur.name !== name) sysMsg(meta.id, `${nameOf(from)} renamed the group to ${name}`);
    else if (cur.members.length !== members.length) sysMsg(meta.id, `${nameOf(from)} changed who's in the group`);
    Vault.save();
  }
  function addMsg(rid, m) {
    const list = D.msgs[rid] || (D.msgs[rid] = []);
    if (m.mid && list.some(x => x.mid === m.mid)) return;
    list.push(m);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    const r = D.rooms[rid];
    if (!m.sys && m.from !== D.me) {
      if (rid !== S.view || !document.hasFocus() || S.black) D.unread[rid] = (D.unread[rid] || 0) + 1;
      if (r && r.kind !== 'general') {
        const who = nameOf(m.from);
        notify(r.kind === 'dm' ? who : `${who} in ${r.name}`, D.settings.previews ? m.text.slice(0, 160) : r.kind === 'dm' ? 'Sent you a message' : 'New message');
      }
    }
    Vault.save();
    if (rid === S.view && !S.black) appendLine(m);
    renderSidebar();
  }
  const sysMsg = (rid, text) => addMsg(rid, { sys: true, text, at: Date.now() });
  // Deletes direct messages older than 24 hours. Runs every minute, on focus and when a chat opens.
  function pruneDms() {
    if (!S.unlocked) return;
    const cutoff = Date.now() - DM_TTL;
    let changed = false;
    for (const r of Object.values(D.rooms)) {
      const list = r.kind === 'dm' && D.msgs[r.id];
      if (!list || !list.length || list[0].at > cutoff) continue;
      D.msgs[r.id] = list.filter(m => m.at > cutoff || m.st === 'pending');
      if (D.unread[r.id] > D.msgs[r.id].length) D.unread[r.id] = D.msgs[r.id].length;
      changed = true;
    }
    if (!changed) return;
    Vault.save();
    renderSidebar();
    if (D.rooms[S.view] && D.rooms[S.view].kind === 'dm') renderLog();
  }
  setInterval(pruneDms, 60000);
  window.addEventListener('focus', pruneDms);
  // Desktop notifications, only while privatewebchat is in the background and never while blacked out
  function notify(title, body) {
    if (!D.settings.notify || S.black || document.hasFocus()) return;
    native.notify(title, body);
    native.attention();
  }

  // ──────────── Friends ────────────
  // D.friends[id] is 'friend', 'incoming' (they asked you) or 'outgoing' (you asked them)
  async function sendControl(id, payload) {
    if (!S.info[id]) return false;
    try { return await sendPayload({ kind: 'dm', with: id }, payload); } catch (e) { return false; }
  }
  function onFriend(op, from) {
    const st = D.friends[from], who = nameOf(from);
    if (op === 'request') {
      if (st === 'friend') { sendControl(from, { k: 'friend', op: 'accept' }); return; }
      if (st === 'outgoing') { D.friends[from] = 'friend'; sendControl(from, { k: 'friend', op: 'accept' }); notify('New friend', `You and ${who} are now friends`); }
      else { D.friends[from] = 'incoming'; notify('Friend request', `${who} wants to be your friend`); }
    } else if (op === 'accept') {
      if (st !== 'outgoing' && st !== 'friend') return;
      if (st === 'outgoing') notify('Friend request accepted', `${who} accepted your friend request`);
      D.friends[from] = 'friend';
    } else if (op === 'decline' || op === 'cancel' || op === 'remove') {
      if (!st) return;
      delete D.friends[from];
    } else return;
    Vault.save();
    render();
  }
  // What the buttons do. Returns an error message, or null.
  async function friendAction(op, id) {
    const st = D.friends[id];
    if (S.status !== 'online') return 'Not connected right now';
    if (op === 'request') {
      if (id === D.me) return "That's you!";
      if (D.blocked[id]) return `Unblock ${nameOf(id)} first`;
      if (st === 'friend') return `You're already friends with ${nameOf(id)}`;
      if (st === 'outgoing') return 'Request already sent';
      if (st === 'incoming') op = 'accept';
    }
    if (!(await sendControl(id, { k: 'friend', op }))) return "Couldn't send that";
    if (op === 'request') D.friends[id] = 'outgoing';
    else if (op === 'accept') D.friends[id] = 'friend';
    else delete D.friends[id];
    Vault.save(); render();
    return null;
  }
  async function block(id) {
    const st = D.friends[id];
    if (st) await sendControl(id, { k: 'friend', op: st === 'incoming' ? 'decline' : st === 'outgoing' ? 'cancel' : 'remove' });
    delete D.friends[id];
    D.blocked[id] = true;
    Vault.save(); render();
  }
  function unblock(id) { delete D.blocked[id]; Vault.save(); render(); }

  // ──────────── Sending ────────────
  const roomMeta = r => ({ id: r.id, name: r.name, members: r.members, rv: r.rv });
  function recipients(r) {
    const ids = r.kind === 'general' ? Object.keys(S.info) : r.kind === 'dm' ? [r.with] : r.members;
    return ids.filter(id => id !== D.me && S.info[id]).map(id => ({ id, ecdh: S.info[id].ecdh }));
  }
  const sentRefs = new Map();   // message id -> chat id, while waiting for the server
  async function sendPayload(r, payload, ref) {
    const to = recipients(r);
    if (!to.length) return false;
    const sealed = await S.box.seal(payload, to);
    if (ref) sentRefs.set(ref, r.id);
    // The server also drops undelivered DMs after 24 hours
    return wsSend({ t: 'send', ref, ttl: r.kind === 'dm' && payload.k === 'msg' ? DM_TTL : undefined, ...sealed });
  }
  async function sendMsg() {
    const text = $('msg').value.replace(/\s+$/, '').replace(/^\n+/, '');
    if (!text.trim()) return;
    const r = D.rooms[S.view];
    if (!r) return;
    if (S.status !== 'online') return err('chatErr', 'Not connected right now');
    if (r.kind === 'dm' && !isFriend(r.with)) return err('chatErr', `You can only message friends`);
    err('chatErr', '');
    const mid = P.randomHex(12);
    const m = { mid, from: D.me, text: text.slice(0, P.MAX_TEXT), at: Date.now(), st: 'pending' };
    $('msg').value = ''; grow(); left();
    if (!recipients(r).length) { delete m.st; addMsg(r.id, m); return; }
    addMsg(r.id, m);
    await deliver(r, m);
  }
  async function deliver(r, m) {
    const payload = { k: 'msg', room: r.id, mid: m.mid, text: m.text, meta: r.kind === 'group' ? roomMeta(r) : undefined };
    try { if (!(await sendPayload(r, payload, m.mid))) markFailed(m.mid); }
    catch (e) { markFailed(m.mid); err('chatErr', "That message couldn't be encrypted"); }
  }
  function findMsg(ref) { const rid = sentRefs.get(ref); return rid && D.msgs[rid] ? [rid, D.msgs[rid].find(x => x.mid === ref)] : [rid, null]; }
  function markSent(ref) { const [rid, m] = findMsg(ref); sentRefs.delete(ref); if (m) { delete m.st; Vault.save(); if (rid === S.view) renderLog(); } }
  function markFailed(ref) { const [rid, m] = findMsg(ref); sentRefs.delete(ref); if (m) { m.st = 'failed'; Vault.save(); if (rid === S.view) renderLog(); } }
  function failPending() { for (const ref of [...sentRefs.keys()]) markFailed(ref); }

  // ──────────── Rendering ────────────
  function render() {
    if (!S.unlocked) return;
    $('meBox').replaceChildren(avatar(D.me, 'sm', true), h('span', { class: 'nm', text: nameOf(D.me) }));
    $('panicKbd').textContent = keyLabel(D.settings.panicCode);
    renderSidebar();
    const friends = S.view === 'friends';
    if (!friends && !D.rooms[S.view]) S.view = 'friends';
    $('friendsPane').classList.toggle('hidden', S.view !== 'friends');
    $('chatPane').classList.toggle('hidden', S.view === 'friends');
    if (S.view === 'friends') renderFriends();
    else { renderHeader(); renderLog(); renderComposer(); }
  }
  const chatName = r => r.kind === 'general' ? 'General' : r.kind === 'dm' ? nameOf(r.with) : r.name;
  const lastAt = r => { const l = D.msgs[r.id]; return l && l.length ? l[l.length - 1].at : (r.rv || 0); };
  function updateTitle() {
    if (S.black) return native.title('privatewebchat');
    const n = Object.values(D.unread).reduce((a, b) => a + b, 0) + Object.values(D.friends).filter(x => x === 'incoming').length;
    native.title(n ? `privatewebchat (${n})` : 'privatewebchat');
  }
  const badge = (el, n) => { el.textContent = n > 99 ? '99+' : n; el.classList.toggle('hidden', !n); };
  function renderSidebar() {
    if (!S.unlocked) return;
    $('navFriends').classList.toggle('on', S.view === 'friends');
    $('navGeneral').classList.toggle('on', S.view === 'general');
    const incoming = Object.values(D.friends).filter(x => x === 'incoming').length;
    badge($('friendsBadge'), incoming);
    badge($('generalBadge'), D.unread.general || 0);
    // The inbox: direct messages with friends (or with past messages) and group chats, newest first
    const chats = Object.values(D.rooms).filter(r => r.kind === 'group' || (r.kind === 'dm' && (isFriend(r.with) || (D.msgs[r.id] || []).length)))
      .sort((a, b) => lastAt(b) - lastAt(a));
    $('inbox').replaceChildren(...(chats.length ? chats.map(r => {
      const n = D.unread[r.id] || 0;
      return h('button', { class: 'item' + (r.id === S.view ? ' on' : ''), onclick: () => openRoom(r.id) },
        r.kind === 'dm' ? avatar(r.with, 'sm', true) : groupAvatar(r, 'sm'),
        h('span', { class: 'grow' }, h('span', { class: 'nm', text: chatName(r) }), r.kind === 'group' ? h('span', { class: 'sub2', text: `${r.members.length} members` }) : null),
        n ? h('span', { class: 'badge', text: n > 99 ? '99+' : n }) : null);
    }) : [h('p', { class: 'hint', style: 'padding: 0.3rem 0.55rem', text: 'Your direct messages and group chats show up here.' })]));
    updateTitle();
  }

  // ── Friends page ──
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => { S.ftab = t.dataset.tab; renderFriends(); };
  $('navFriends').onclick = () => openFriends();
  $('navGeneral').onclick = () => openRoom('general');
  function openFriends(tab) { S.view = 'friends'; if (tab) S.ftab = tab; err('chatErr', ''); render(); }
  function personRow(id, sub, actions) {
    return h('div', { class: 'frow', onclick: e => { if (!e.target.closest('button')) profile(id); } },
      avatar(id, '', true), h('div', { class: 'who' }, h('b', { text: nameOf(id) }), h('small', { text: sub })),
      h('div', { class: 'acts' }, actions));
  }
  const act = (label, fn, cls) => h('button', { class: 'link' + (cls ? ' ' + cls : ''), onclick: async e => { e.stopPropagation(); const m = await fn(); if (m) friendsNote(m); } }, label);
  let noteT = null;
  function friendsNote(m, ok) { const n = $('friendsBody').querySelector('.fnote'); if (n) { n.textContent = m; n.className = 'err fnote' + (ok ? ' ok' : ''); clearTimeout(noteT); noteT = setTimeout(() => { n.textContent = ''; }, 5000); } }
  function renderFriends() {
    if (!S.unlocked || S.view !== 'friends') return;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === S.ftab);
    badge($('pendingBadge'), Object.values(D.friends).filter(x => x === 'incoming').length);
    const body = $('friendsBody');
    const byName = ids => ids.filter(id => S.info[id] || D.names[id]).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const friends = byName(Object.keys(D.friends).filter(isFriend));
    const message = id => act('Message', () => openRoom(ensureDm(id).id));
    const status = id => isOnline(id) ? 'Online' : 'Offline';
    let rows = [], head = '', empty = '';
    if (S.ftab === 'online' || S.ftab === 'all') {
      const list = S.ftab === 'online' ? friends.filter(isOnline) : friends;
      head = `${S.ftab === 'online' ? 'Online' : 'All friends'} — ${list.length}`;
      rows = list.map(id => personRow(id, status(id), [message(id)]));
      empty = friends.length ? "None of your friends are online right now." : "No friends yet. Add someone by their username, or see who's in the network under Add friend.";
    } else if (S.ftab === 'pending') {
      const inc = byName(Object.keys(D.friends).filter(id => D.friends[id] === 'incoming'));
      const out = byName(Object.keys(D.friends).filter(id => D.friends[id] === 'outgoing'));
      head = `Pending — ${inc.length + out.length}`;
      rows = [...inc.map(id => personRow(id, 'Incoming friend request', [act('Accept', () => friendAction('accept', id)), act('Decline', () => friendAction('decline', id), 'danger')])),
        ...out.map(id => personRow(id, 'Outgoing friend request', [act('Cancel', () => friendAction('cancel', id))]))];
      empty = 'No pending friend requests.';
    } else if (S.ftab === 'blocked') {
      const list = byName(Object.keys(D.blocked));
      head = `Blocked — ${list.length}`;
      rows = list.map(id => personRow(id, 'Blocked', [act('Unblock', () => unblock(id))]));
      empty = "You haven't blocked anyone.";
    }
    if (S.ftab !== 'add') {
      body.replaceChildren(h('div', { class: 'err fnote' }), h('div', { class: 'fhead', text: head }), ...(rows.length ? rows : [h('div', { class: 'empty', text: empty })]));
      return;
    }
    // Add friend: by username, or from the list of everyone in the network. Keeps what you were
    // typing when the page redraws because someone came online.
    const prev = body.querySelector('.addbox input');
    const input = h('input', { placeholder: 'Enter a username', maxlength: 24, spellcheck: 'false', value: prev ? prev.value : '' });
    const refocus = !prev || document.activeElement === prev;
    const send = h('button', {
      class: 'btn', onclick: async () => {
        const name = input.value.trim().toLowerCase();
        if (!name) return;
        const target = Object.values(S.info).find(i => i.name.toLowerCase() === name);
        if (!target) return friendsNote(`Nobody in this network is called ${input.value.trim()}. Usernames are exact, but not case-sensitive.`);
        const m = await friendAction('request', target.id);
        if (m) return friendsNote(m);
        input.value = '';
        friendsNote(`Friend request sent to ${target.name}`, true);
      },
    }, 'Send friend request');
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send.click(); });
    const others = Object.values(S.info).filter(i => i.id !== D.me).map(i => i.id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const stateFor = id => {
      const st = D.friends[id];
      if (D.blocked[id]) return h('span', { class: 'tagline', text: 'Blocked' });
      if (st === 'friend') return h('span', { class: 'tagline ok', text: 'Friends' });
      if (st === 'outgoing') return h('span', { class: 'tagline', text: 'Request sent' });
      if (st === 'incoming') return act('Accept', () => friendAction('accept', id));
      return act('Add friend', () => friendAction('request', id));
    };
    body.replaceChildren(
      h('div', { class: 'fhead', text: 'Add friend' }),
      h('p', { class: 'hint', text: 'You can add anyone in this network by their username.' }),
      h('div', { class: 'addbox' }, input, send),
      h('div', { class: 'err fnote' }),
      h('div', { class: 'fhead gap', text: `Everyone in this network — ${others.length}` }),
      ...(others.length ? others.map(id => personRow(id, status(id), [stateFor(id)]))
        : [h('div', { class: 'empty' }, h('b', {}, "It's just you so far."), 'More people will show up here as the developer invites them.')]));
    if (refocus) setTimeout(() => input.focus(), 0);
  }

  // ── Chats ──
  function renderHeader() {
    const r = D.rooms[S.view];
    if (!r) return;
    const count = Object.keys(S.info).length;
    $('roomAv').replaceChildren(r.kind === 'dm' ? avatar(r.with, '', true) : r.kind === 'group' ? groupAvatar(r) : '');
    $('roomTitle').textContent = (r.kind === 'general' ? '# ' : '') + chatName(r);
    $('roomSub').textContent = r.kind === 'general' ? `Everyone · ${count} ${count === 1 ? 'member' : 'members'}`
      : r.kind === 'dm' ? (isOnline(r.with) ? 'Online' : 'Offline') + ' · messages disappear after 24 hours'
      : r.members.map(nameOf).join(', ');
    const a = $('roomAction');
    a.classList.toggle('hidden', r.kind === 'general');
    a.textContent = r.kind === 'group' ? 'Group settings' : 'Profile';
    a.onclick = () => r.kind === 'group' ? groupSettings() : profile(r.with);
  }
  let shownAll = false;
  function renderLog() {
    if (!S.unlocked || S.black || S.view === 'friends') return;
    const log = $('log');
    log.innerHTML = '';
    const list = D.msgs[S.view] || [];
    const from = shownAll ? 0 : Math.max(0, list.length - SHOWN);
    if (from > 0) log.append(h('button', { class: 'link older', onclick: () => { shownAll = true; renderLog(); log.scrollTop = 0; } }, `Show ${from} older messages`));
    const r = D.rooms[S.view];
    if (!list.length) log.append(h('div', { class: 'sys', text: r.kind === 'general' ? 'This is the start of General. Everyone in the network can read what you send here, and nobody else can, not even the server.'
      : r.kind === 'dm' ? `This is your conversation with ${nameOf(r.with)}. Only the two of you can read it, and messages are deleted after 24 hours.` : 'This is the start of the group. Only its members can read it.' }));
    for (let i = from; i < list.length; i++) appendLine(list[i], true);
    log.scrollTop = log.scrollHeight;
  }
  function appendLine(m, bulk) {
    const log = $('log');
    if (!m.sys && D.blocked[m.from]) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    let line;
    if (m.sys) line = h('div', { class: 'sys', text: m.text });
    else {
      const mine = m.from === D.me, nm = nameOf(m.from);
      line = h('div', { class: 'm' + (mine ? ' me' : '') + (m.st === 'pending' ? ' pending' : '') },
        h('time', { text: fmtTime(m.at) }), h('b', { text: nm, style: `--h: ${hue(nm)}`, onclick: () => profile(m.from) }), m.text,
        m.st === 'failed' ? h('button', { class: 'fail', title: 'Send again', onclick: () => { m.st = 'pending'; renderLog(); deliver(D.rooms[S.view], m); } }, 'Not sent · Retry') : null);
    }
    log.append(line);
    if (!bulk && (atBottom || m.from === D.me)) log.scrollTop = log.scrollHeight;
  }
  function renderComposer() {
    if (!S.unlocked) return;
    const r = D.rooms[S.view];
    if (!r) return;
    const locked = r.kind === 'dm' && !isFriend(r.with);
    $('msg').disabled = locked;
    $('msg').placeholder = locked ? `You can only message friends. Add ${nameOf(r.with)} as a friend to keep chatting.`
      : r.kind === 'dm' ? `Message @${nameOf(r.with)}` : r.kind === 'general' ? 'Message #General' : `Message ${r.name}`;
    $('sendBtn').disabled = S.status !== 'online' || locked;
    const path = r.kind === 'general' ? 'general' : r.kind === 'dm' ? 'dm/' + nameOf(r.with) : r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    $('promptTop').replaceChildren('┌──(', h('b', { class: 'pu', text: `${nameOf(D.me)}㉿privatewebchat` }), ')-[', h('b', { class: 'pp', text: '~/' + path }), ']');
  }
  function openRoom(id) {
    if (!D.rooms[id]) return;
    pruneDms();
    S.view = id; shownAll = false;
    delete D.unread[id];
    Vault.save();
    err('chatErr', '');
    closeModal();
    render();
    if (!$('msg').disabled) $('msg').focus();
  }
  window.addEventListener('focus', () => { if (S.unlocked && !S.black && D.unread[S.view]) { delete D.unread[S.view]; Vault.save(); renderSidebar(); } });

  // ── Composer ──
  const grow = () => { const t = $('msg'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; };
  const left = () => { const n = P.MAX_TEXT - $('msg').value.length; $('msgLeft').textContent = n <= 200 ? n : ''; $('msgLeft').classList.toggle('low', n <= 30); };
  $('msg').addEventListener('input', () => { grow(); left(); });
  $('msg').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); } });
  $('sendBtn').onclick = sendMsg;

  // ──────────── Group chats ────────────
  function friendChecks(exclude) {
    const people = Object.keys(D.friends).filter(id => isFriend(id) && S.info[id] && !exclude.includes(id)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    if (!people.length) return [h('p', { class: 'hint', text: exclude.length > 1 ? 'All your friends are already here.' : 'Group chats are for friends. Add some friends first.' }), []];
    const boxes = people.map(id => h('input', { type: 'checkbox', value: id }));
    return [h('div', { class: 'list' }, people.map((id, n) => h('label', { class: 'check' }, boxes[n], avatar(id, 'sm', true), nameOf(id)))), boxes];
  }
  $('newGroup').onclick = () => {
    const name = h('input', { class: 'in', maxlength: 40, placeholder: 'Optional' });
    const [list, boxes] = friendChecks([]);
    const e = h('div', { class: 'err' });
    modal('New group chat', h('label', { class: 'lbl', text: 'Pick friends' }), list, h('label', { class: 'lbl', text: 'Group name' }), name, e,
      h('div', { class: 'row end' }, h('button', { class: 'link', onclick: closeModal }, 'Cancel'), h('button', {
        class: 'btn', onclick: async () => {
          const picked = boxes.filter(b => b.checked).map(b => b.value);
          if (!picked.length) { e.textContent = 'Pick at least one friend'; return; }
          const n = P.cleanName(name.value, 40) || P.cleanName([D.me, ...picked].map(nameOf).join(', '), 40);
          const r = { id: 'g:' + P.randomHex(16), kind: 'group', name: n, members: [D.me, ...picked], rv: Date.now() };
          D.rooms[r.id] = r;
          sysMsg(r.id, `You made ${n}`);
          await sendPayload(r, { k: 'room', room: roomMeta(r) });
          closeModal(); openRoom(r.id);
        },
      }, 'Create group')));
  };
  function groupSettings() {
    const r = D.rooms[S.view];
    if (!r || r.kind !== 'group') return;
    const name = h('input', { class: 'in', maxlength: 40, value: r.name });
    const [list, boxes] = friendChecks(r.members);
    async function update(next, note) {
      const old = r.members;
      const nr = { ...r, ...next, rv: Math.max(Date.now(), r.rv + 1) };
      // Tell everyone who was or is in the group
      await sendPayload({ ...nr, members: [...new Set([...old, ...nr.members])] }, { k: 'room', room: roomMeta(nr) });
      if (nr.members.includes(D.me)) { D.rooms[r.id] = nr; if (note) sysMsg(r.id, note); }
      else { delete D.rooms[r.id]; delete D.msgs[r.id]; delete D.unread[r.id]; S.view = 'friends'; }
      Vault.save(); closeModal(); render();
    }
    modal('Group settings',
      h('label', { class: 'lbl', text: 'Name' }), h('div', { class: 'row', style: 'margin-top:0' }, name, h('button', { class: 'link', onclick: () => { const n = P.cleanName(name.value, 40); if (n && n !== r.name) update({ name: n }, `You renamed the group to ${n}`); } }, 'Rename')),
      h('label', { class: 'lbl', text: 'Members' }), h('div', { class: 'list' }, r.members.map(id => h('div', { class: 'li' }, avatar(id, 'sm', true), h('span', { class: 'grow', text: nameOf(id) + (id === D.me ? ' (you)' : '') })))),
      h('label', { class: 'lbl', text: 'Add friends' }), list,
      boxes.length ? h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => { const add = boxes.filter(b => b.checked).map(b => b.value); if (add.length) update({ members: [...r.members, ...add] }, `You added ${add.map(nameOf).join(', ')}`); } }, 'Add')) : null,
      h('hr', { class: 'sep' }),
      h('div', { class: 'row end' }, h('button', { class: 'link danger', onclick: () => ask('Leave this group?', "You'll stop getting its messages and its history will be deleted from this device.", 'Leave', () => update({ members: r.members.filter(x => x !== D.me) }), true) }, 'Leave group'), h('button', { class: 'link', onclick: closeModal }, 'Close')));
  }

  // ──────────── Profiles, invites and members ────────────
  function profile(id) {
    if (!S.info[id] && !D.names[id]) return;
    const i = S.info[id], st = D.friends[id], me = id === D.me;
    const note = h('div', { class: 'err' });
    const run = fn => async () => { const m = await fn(); if (m) note.textContent = m; else closeModal(); };
    const btns = [];
    if (!me && i) {
      if (D.blocked[id]) btns.push(h('button', { class: 'link', onclick: run(() => unblock(id)) }, 'Unblock'));
      else if (st === 'friend') btns.push(h('button', { class: 'btn', onclick: () => openRoom(ensureDm(id).id) }, 'Message'));
      else if (st === 'incoming') btns.push(h('button', { class: 'btn', onclick: run(() => friendAction('accept', id)) }, 'Accept friend request'), h('button', { class: 'link', onclick: run(() => friendAction('decline', id)) }, 'Decline'));
      else if (st === 'outgoing') btns.push(h('button', { class: 'link', onclick: run(() => friendAction('cancel', id)) }, 'Cancel friend request'));
      else btns.push(h('button', { class: 'btn', onclick: run(() => friendAction('request', id)) }, 'Add friend'));
    }
    const more = [];
    if (!me && i) {
      more.push(h('button', { class: 'link', onclick: () => safety(id) }, 'Verify safety number'));
      if (st === 'friend') more.push(h('button', { class: 'link', onclick: () => ask(`Remove ${nameOf(id)} as a friend?`, "You won't be able to message each other until one of you sends a new friend request.", 'Remove friend', () => friendAction('remove', id), true) }, 'Remove friend'));
      if (!D.blocked[id]) more.push(h('button', { class: 'link danger', onclick: () => ask(`Block ${nameOf(id)}?`, "You won't see their messages anywhere, and they can't send you friend requests.", 'Block', () => block(id), true) }, 'Block'));
    }
    modal('', h('div', { class: 'profile' }, avatar(id, 'lg', true), h('h2', { text: nameOf(id) + (me ? ' (you)' : '') }),
      h('p', { class: 'hint', text: !i ? 'No longer in this network' : (isOnline(id) ? 'Online' : 'Offline') + (st === 'friend' ? ' · Friends' : '') }),
      btns.length ? h('div', { class: 'row' }, btns) : null, more.length ? h('div', { class: 'row' }, more) : null, note),
      closeBtn());
  }
  $('meBox').onclick = () => profile(D.me);
  async function safety(id) {
    const i = S.info[id];
    if (!i) return;
    const mine = await P.safetyNumber(S.info[D.me]);
    const theirs = await P.safetyNumber(i);
    modal(`Safety number for ${i.name}`,
      h('p', { class: 'hint', text: `Ask ${i.name} to open Settings in privatewebchat and read you their safety number, in person or on a call. If it matches the one below, nobody (not even the server) is reading your messages to them.` }),
      h('div', { class: 'box mono', text: theirs }),
      h('label', { class: 'lbl', text: 'Yours' }), h('div', { class: 'box mono', text: mine }), closeBtn());
  }
  // ──────────── Settings ────────────
  $('settingsBtn').onclick = settings;
  async function settings() {
    const st = D.settings;
    const kbd = h('kbd', { text: keyLabel(st.panicCode) });
    const keyNote = h('div', { class: 'err' });
    const change = h('button', {
      class: 'link', onclick: () => {
        S.capturing = true; change.textContent = 'Press a key…'; keyNote.textContent = '';
        const grab = async e => {
          if (!S.capturing) { window.removeEventListener('keydown', grab, true); return; }   // the dialog was closed
          if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key) || !e.code) return;
          e.preventDefault(); e.stopPropagation();
          window.removeEventListener('keydown', grab, true);
          S.capturing = false;
          st.panicCode = e.code; Vault.save();
          kbd.textContent = keyLabel(e.code); change.textContent = 'Change key';
          $('panicKbd').textContent = keyLabel(e.code);
          const ok = await applyPanicKey();
          keyNote.className = 'err' + (ok ? ' ok' : '');
          keyNote.textContent = st.panicGlobal && !ok ? "That key can't be used while privatewebchat is in the background. It still works inside privatewebchat." : 'Saved';
          if (e.key.length === 1) keyNote.textContent += ". Heads up: this key types a character, so you can't type it in messages.";
        };
        window.addEventListener('keydown', grab, true);
      },
    }, 'Change key');
    const global = h('input', { type: 'checkbox', checked: st.panicGlobal });
    global.onchange = async () => {
      st.panicGlobal = global.checked; Vault.save();
      const ok = await applyPanicKey();
      keyNote.className = 'err' + (ok || !st.panicGlobal ? ' ok' : '');
      keyNote.textContent = st.panicGlobal && !ok ? "That key can't be used while privatewebchat is in the background. Pick another, like F9." : 'Saved';
    };
    const notifyBox = h('input', { type: 'checkbox', checked: st.notify });
    const previewBox = h('input', { type: 'checkbox', checked: st.previews });
    notifyBox.onchange = () => { st.notify = notifyBox.checked; Vault.save(); };
    previewBox.onchange = () => { st.previews = previewBox.checked; Vault.save(); };

    // PIN fields
    const pinIn = ph => { const i = h('input', { class: 'in pin', type: 'password', inputmode: 'numeric', maxlength: 12, autocomplete: 'off', placeholder: ph }); digitsOnly(i); return i; };
    const cur1 = pinIn('Current PIN'), new1 = pinIn('New PIN'), new2 = pinIn('New PIN again'), pinNote = h('div', { class: 'err' });
    const changePin = h('button', {
      class: 'link', onclick: async () => {
        pinNote.className = 'err';
        if (!validPin(new1.value)) { pinNote.textContent = 'Your PIN needs 4 to 12 digits'; return; }
        if (new1.value !== new2.value) { pinNote.textContent = "The new PINs don't match"; return; }
        if (!(await tryPin(cur1.value, m => { pinNote.textContent = m === 'Wrong PIN' ? 'Your current PIN is wrong' : m; }))) return;
        try { await Vault.setPin(new1.value); pinNote.className = 'err ok'; pinNote.textContent = 'PIN changed'; cur1.value = new1.value = new2.value = ''; }
        catch (e) { pinNote.textContent = e.message; }
      },
    }, 'Change PIN');
    const cur2 = pinIn('Current PIN'), w1 = pinIn('Wipe PIN'), w2 = pinIn('Wipe PIN again'), wipeNote = h('div', { class: 'err' });
    const wipeState = h('b', { text: st.wipeSet ? 'On' : 'Off' });
    async function setWipe(pin) {
      wipeNote.className = 'err';
      if (pin != null) {
        if (!validPin(pin)) { wipeNote.textContent = 'The wipe PIN needs 4 to 12 digits'; return; }
        if (pin !== w2.value) { wipeNote.textContent = "The wipe PINs don't match"; return; }
      }
      if (!(await tryPin(cur2.value, m => { wipeNote.textContent = m === 'Wrong PIN' ? 'Your current PIN is wrong' : m; }))) return;
      try {
        await Vault.setWipePin(pin);
        wipeState.textContent = pin ? 'On' : 'Off';
        wipeNote.className = 'err ok'; wipeNote.textContent = pin ? 'Wipe PIN set' : 'Wipe PIN removed';
        cur2.value = w1.value = w2.value = '';
      } catch (e) { wipeNote.textContent = e.message; }
    }

    const mine = await P.safetyNumber(S.info[D.me] || D.cert.m);
    modal('Settings',
      h('h3', { text: 'Appearance' }),
      themePicker(),

      h('h3', { text: 'Black-out key' }),
      h('p', { class: 'hint' }, 'Press it and privatewebchat instantly goes completely black. To come back, type your PIN on the black screen and press Enter. Nothing shows while you type.'),
      h('div', { class: 'row', style: 'margin-top:0' }, h('span', {}, 'Key: '), kbd, change),
      h('label', { class: 'check' }, global, h('span', {}, 'Also works when privatewebchat is in the background', h('small', { class: 'hint', style: 'display:block;margin:0' }, "privatewebchat takes the key over in every app, so pick one you don't use, like F9."))),
      keyNote,
      h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => { closeModal(); blackout(); } }, 'Black out now')),

      h('h3', { text: 'Wipe PIN' }),
      h('p', { class: 'hint' }, 'A second PIN that ', h('b', {}, 'erases everything'), ' privatewebchat has stored on this computer: your identity, every message and all settings. Entering it on the lock screen or the black screen wipes privatewebchat instantly and it opens as a fresh install. This can\'t be undone. Status: ', wipeState),
      cur2, h('div', { class: 'row' }, w1, w2), wipeNote,
      h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => setWipe(w1.value) }, 'Set wipe PIN'), h('button', { class: 'link', onclick: () => setWipe(null) }, 'Turn off')),

      h('h3', { text: 'Notifications' }),
      h('label', { class: 'check' }, notifyBox, 'Desktop notifications for direct messages, group chats and friend requests while privatewebchat is in the background'),
      h('label', { class: 'check' }, previewBox, 'Show message text in notifications'),

      h('h3', { text: 'PIN' }),
      cur1, h('div', { class: 'row' }, new1, new2), pinNote,
      h('div', { class: 'row' }, changePin),

      h('h3', { text: 'This device' }),
      h('p', { class: 'hint' }, 'Username: ', h('b', { text: nameOf(D.me) }), " (usernames can't be changed)"),
      h('p', { class: 'hint' }, 'Server: ', h('b', { text: D.server.replace(/^wss:\/\//, '') })),
      h('label', { class: 'lbl', text: 'Your safety number' }), h('div', { class: 'box mono', text: mine }),

      h('h3', { text: 'Erase' }),
      h('div', { class: 'row', style: 'margin-top:0' }, h('button', { class: 'link danger', onclick: () => ask('Erase everything now?', 'This deletes your identity, every message and all settings from this computer. It cannot be undone.', 'Erase', wipe, true) }, 'Erase everything on this device')),
      closeBtn());
  }

  // ──────────── Black-out ────────────
  async function applyPanicKey() {
    const st = D.settings;
    try { return !!(await native.panic(st.panicCode || '', !!(st.panicGlobal && st.panicCode))); } catch (e) { return false; }
  }
  function blackout() {
    if (!S.unlocked || S.black) return;
    S.black = true;
    closeModal();
    $('app').classList.add('hidden');
    $('black').classList.remove('hidden');
    $('blackPin').value = ''; dots();
    native.title('privatewebchat');
    setTimeout(() => $('blackPin').focus(), 0);
  }
  function unblack() {
    S.black = false;
    $('black').classList.add('hidden');
    $('app').classList.remove('hidden');
    if (D.unread[S.view] && document.hasFocus()) delete D.unread[S.view];
    render();
    if (S.view !== 'friends') $('msg').focus();
  }
  const dots = () => { $('blackDots').textContent = '•'.repeat($('blackPin').value.length); };
  window.PwcPanic = blackout;
  // The black-out key is checked before anything else on the page sees it
  window.addEventListener('keydown', e => {
    if (!S.unlocked || S.black || S.capturing || !D.settings.panicCode) return;
    if (e.code === D.settings.panicCode && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); blackout(); }
  }, true);
  $('panicBtn').onclick = blackout;
  $('black').addEventListener('mousedown', e => { e.preventDefault(); $('blackPin').focus(); });
  $('blackPin').addEventListener('blur', () => { if (S.black) setTimeout(() => $('blackPin').focus(), 0); });
  $('blackPin').addEventListener('input', () => { $('blackPin').value = $('blackPin').value.replace(/\D/g, ''); dots(); });
  $('blackPin').addEventListener('keydown', async e => {
    if (e.key === 'Escape') { $('blackPin').value = ''; dots(); return; }
    if (e.key !== 'Enter') return;
    const pin = $('blackPin').value;
    $('blackPin').value = ''; dots();
    if (!pin) return;
    const ok = await tryPin(pin, () => { const d = $('blackDots'); d.textContent = '•••'; d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); setTimeout(() => { d.textContent = ''; }, 600); });
    if (ok) unblack();
  });

  // ──────────── Wipe ────────────
  async function wipe() {
    $('app').classList.add('hidden'); closeModal();
    stopNet();
    S.unlocked = false; D = null;
    await Vault.lock();   // so a save that's already running can't write the vault back afterwards
    try { await window.pwc_wipe(); } catch (e) { }
    location.reload();
  }

  boot();
})();
