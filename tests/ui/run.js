// End-to-end UI test: three people (Maya owns the network, Sam and Leo are invited) use the real
// UI in headless Chrome against the real relay server. mock.js stands in for the native bindings.
// Also saves the README screenshots to docs/images.
// Usage: node tests/ui/run.js   (needs Google Chrome)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '../..');
const UI = path.join(ROOT, 'app/ui');
const SHOTS = path.join(ROOT, 'docs/images');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UI_PORT = 18900, RELAY_PORT = 18901, CDP_PORT = 18902;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];

// ── The UI, served the way the app serves it, with mock.js added ──
function serveUi() {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
  return new Promise(res => http.createServer((req, rsp) => {
    const name = path.basename(req.url.split('?')[0]) || 'index.html';
    const file = name === 'mock.js' ? path.join(__dirname, 'mock.js') : path.join(UI, name);
    if (!fs.existsSync(file)) { rsp.writeHead(404); return rsp.end(); }
    let body = fs.readFileSync(file);
    if (name === 'index.html') body = String(body).replace('<script src="protocol.js">', '<script src="mock.js"></script>\n  <script src="protocol.js">');
    rsp.writeHead(200, { 'Content-Type': types[path.extname(file)], 'Cache-Control': 'no-store' });
    rsp.end(body);
  }).listen(UI_PORT, '127.0.0.1', res));
}
let relay = null;
function startRelay(owner) {
  return new Promise(res => {
    relay = spawn('node', [path.join(ROOT, 'server/index.js')], { env: { ...process.env, PORT: RELAY_PORT, OWNER_KEY: owner } });
    procs.push(relay);
    relay.stdout.on('data', d => { if (String(d).includes('privatewebchat relay on port')) res(); });
  });
}
async function stopRelay() { if (relay) { relay.kill(); relay = null; await sleep(300); } }

// ── A tiny Chrome DevTools Protocol client ──
async function newPage(name) {
  const t = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => { ws.onopen = r; });
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const [res, rej] = waiting.get(m.id); waiting.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') console.error(`[${name}] page error:`, m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, [res, rej]); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const p = {
    name, send,
    size: (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false }),
    async js(expr) {
      const r = await send('Runtime.evaluate', { expression: `(async () => { const $ = id => document.getElementById(id); ${expr} })()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`[${name}] ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      return r.result.value;
    },
    async until(expr, what, ms = 20000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await p.js(`return !!(${expr})`).catch(() => false)) return; await sleep(150); }
      throw new Error(`[${name}] timed out waiting for ${what}`);
    },
    goto: async url => { await send('Page.navigate', { url }); await sleep(400); },
    reload: async () => { await send('Page.reload', { ignoreCache: true }); await sleep(600); },
    key: async (key, code, vk) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    async shot(file) {
      if (!process.env.NO_SHOTS) {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.data, 'base64'));
      }
    },
    // Fill a field and fire the events the UI listens for
    fill: (sel, value) => p.js(`const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('input'));`),
    click: sel => p.js(`document.querySelector(${JSON.stringify(sel)}).click()`),
    clickText: text => p.js(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`),
    screen: () => p.js(`return [...document.querySelectorAll('section')].filter(s => !s.classList.contains('hidden')).map(s => s.id).join()`),
    async say(text) {
      await p.fill('#msg', text);
      await p.js(`$('msg').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await p.until(`![...document.querySelectorAll('#log .m.pending')].length`, 'message sent');
    },
  };
  return p;
}
const url = `http://127.0.0.1:${UI_PORT}/test/index.html`;
const online = p => p.until(`$('netDot').classList.contains('on')`, 'connected', 45000);
async function setPin(p, pin) {
  await p.until(`!$('sSetPin').classList.contains('hidden')`, 'PIN screen');
  await p.fill('#newPin', pin); await p.fill('#newPin2', pin);
  await p.click('#setPinGo');
  await p.until(`!$('sMain').classList.contains('hidden')`, 'main screen');
}
async function invite(owner) {
  await owner.click('#inviteBtn');
  await owner.clickText('Create invite');
  await owner.until(`document.querySelector('#modalCard textarea')`, 'invite code');
  const code = await owner.js(`return document.querySelector('#modalCard textarea').value`);
  return code;
}
async function join(p, code, name, pin) {
  await p.goto(url);
  await p.until(`!$('sWelcome').classList.contains('hidden')`, 'welcome');
  await p.click('#goJoin');
  await p.fill('#joinCode', code); await p.fill('#joinName', name);
  await p.until(`$('joinFrom').textContent.includes('Invite from')`, 'invite check');
  await p.click('#joinNext');
  await setPin(p, pin);
  await online(p);
}
// Sidebar entries: Friends, General and the inbox
const nav = (p, label) => p.js(`[...document.querySelectorAll('.side .item')].find(b => b.querySelector('.nm').textContent === ${JSON.stringify(label)}).click()`);
const tab = (p, name) => p.click(`.tab[data-tab="${name}"]`);
const lastMsg = p => p.js(`const m = [...document.querySelectorAll('#log .m')].pop(); return m ? m.textContent : ''`);
const rowAction = (p, who, label) => p.js(`const r = [...document.querySelectorAll('#friendsBody .frow')].find(r => r.querySelector('.who b').textContent === ${JSON.stringify(who)});
  [...r.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`);
async function pickTheme(p, name) {
  await p.click('#settingsBtn');
  await p.until(`$('modalCard').textContent.includes('Appearance')`, 'settings');
  await p.js(`[...document.querySelectorAll('.theme-card')].find(c => c.querySelector('.tn').firstChild.textContent === ${JSON.stringify(name)}).click()`);
  await p.until(`document.documentElement.dataset.theme === ${JSON.stringify(name.toLowerCase())}`, 'theme ' + name);
  await sleep(150);
  await p.clickText('Close');
}
const background = (p, on) => p.js(`if (${on}) document.hasFocus = () => false; else delete document.hasFocus;`);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await serveUi();
  await startRelay('');
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${fs.mkdtempSync('/tmp/pwc-uitest-')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  procs.push(chrome);
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(200); } }

  const maya = await newPage('maya'), sam = await newPage('sam'), leo = await newPage('leo');
  for (const p of [maya, sam, leo]) await p.size(1100, 700);

  // ── Maya starts a network ──
  await maya.goto(url);
  await maya.until(`!$('sWelcome').classList.contains('hidden')`, 'welcome');
  await maya.shot('welcome.png');
  await maya.click('#goCreate');
  await maya.fill('#createServer', `ws://127.0.0.1:${RELAY_PORT}`);
  await maya.fill('#createName', 'maya k');
  await maya.click('#createNext');
  assert((await maya.js(`return $('createErr').textContent`)).includes('letters, numbers'), 'spaces refused in usernames');
  await maya.fill('#createName', 'maya');
  await maya.click('#createNext');
  await maya.fill('#newPin', '12'); await maya.fill('#newPin2', '12');
  await maya.click('#setPinGo');
  assert((await maya.js(`return $('setPinErr').textContent`)).includes('4 to 12'), 'short PIN refused');
  await setPin(maya, '1234');
  // The relay has no OWNER_KEY yet, so privatewebchat walks Maya through adding it
  await maya.until(`$('modalCard').dataset.kind === 'setup'`, 'owner setup');
  await maya.shot('owner-key.png');
  const ownerKey = await maya.js(`return document.querySelector('#modalCard .box').textContent`);
  await stopRelay();
  await startRelay(ownerKey);
  await online(maya);
  console.log('✓ owner set up the network');

  // ── Invites ──
  const code1 = await invite(maya);
  await maya.shot('invite.png');
  await maya.clickText('Close');
  await join(sam, code1, 'sam', '5678');
  console.log('✓ sam joined with an invite');
  const reuse = await newPage('reuse');
  await reuse.size(1100, 700);
  await reuse.goto(url);
  await reuse.until(`!$('sWelcome').classList.contains('hidden')`, 'welcome');
  await reuse.click('#goJoin');
  await reuse.fill('#joinCode', code1); await reuse.fill('#joinName', 'eve');
  await reuse.until(`$('joinFrom').textContent.includes('Invite from')`, 'invite check');
  await reuse.click('#joinNext');
  await reuse.fill('#newPin', '1111'); await reuse.fill('#newPin2', '1111'); await reuse.click('#setPinGo');
  await reuse.until(`!$('sGone').classList.contains('hidden')`, 'refused');
  console.log('✓ a used invite is refused');
  const code2 = await invite(maya);
  await maya.clickText('Close');
  await join(leo, code2, 'leo', '2468');
  console.log('✓ leo joined');

  // ── General: everyone in the network ──
  await nav(maya, 'General');
  await maya.say('Welcome to privatewebchat 👋 Everything in here is end-to-end encrypted.');
  for (const p of [sam, leo]) { await nav(p, 'General'); await p.until(`$('log').textContent.includes('Welcome to privatewebchat')`, 'General message'); }
  await sam.say('This is so much faster than the old chat');
  await leo.until(`$('log').textContent.includes('so much faster')`, 'leo receives');
  await leo.say('So the server really can’t read any of this?');
  await maya.until(`$('log').textContent.includes('really can’t read')`, 'maya receives');
  await maya.say('Nope. It only passes along ciphertext.');
  await sam.until(`$('log').textContent.includes('passes along')`, 'sam receives');
  console.log('✓ General works for everyone');

  // ── Friends ──
  await nav(sam, 'Friends'); await tab(sam, 'add');
  await sam.shot('add-friend.png');
  await background(maya, true);
  await sam.fill('#friendsBody .addbox input', 'MAYA');
  await sam.clickText('Send friend request');
  await sam.until(`$('friendsBody').textContent.includes('Friend request sent to maya')`, 'request sent');
  await maya.until(`!$('friendsBadge').classList.contains('hidden')`, 'friends badge');
  assert((await maya.js(`return window.__notes.map(n => n.title + ': ' + n.body).join('|')`)).includes('Friend request: sam wants to be your friend'), 'friend request notification');
  await background(maya, false);
  await nav(leo, 'Friends'); await tab(leo, 'add');
  await rowAction(leo, 'maya', 'Add friend');
  await maya.until(`$('friendsBadge').textContent === '2'`, 'two requests');
  await nav(maya, 'Friends'); await tab(maya, 'pending');
  await maya.shot('friends-pending.png');
  await rowAction(maya, 'sam', 'Accept');
  await rowAction(maya, 'leo', 'Accept');
  await sam.until(`$('friendsBody').textContent.includes('Friends')`, 'sam sees friendship');
  await tab(sam, 'all');
  await sam.until(`$('friendsBody').textContent.includes('maya')`, 'maya in sam friend list');
  console.log('✓ friend requests sent by username and from the list, then accepted');
  // sam and leo aren't friends, so they can't DM each other
  await tab(leo, 'all');
  assert(!(await leo.js(`return $('friendsBody').textContent.includes('sam')`)), 'not friends');
  console.log('✓ direct messages are for friends only');

  // ── A group chat ──
  await maya.click('#newGroup');
  await maya.js(`for (const c of document.querySelectorAll('#modalCard input[type=checkbox]')) c.checked = true`);
  await maya.fill('#modalCard input.in', 'Weekend plans');
  await maya.clickText('Create group');
  await sam.until(`[...document.querySelectorAll('#inbox .nm')].some(n => n.textContent === 'Weekend plans')`, 'sam sees the group');
  await maya.say('Anyone up for the beach on Saturday? 🏖️');
  await nav(sam, 'Weekend plans');
  await sam.until(`$('log').textContent.includes('beach')`, 'sam receives in group');
  await sam.say('Yes! I’ll bring snacks');
  await nav(leo, 'Weekend plans');
  await leo.until(`$('log').textContent.includes('snacks')`, 'leo receives in group');
  await leo.say('Count me in. 10am at the station?');
  await maya.until(`$('log').textContent.includes('10am')`, 'maya receives in group');
  await maya.say('Perfect, see you there');
  await leo.until(`$('log').textContent.includes('see you there')`, 'leo receives');
  console.log('✓ group chat with friends');

  // ── A direct message, with a desktop notification ──
  await background(maya, true);
  await nav(sam, 'Friends'); await tab(sam, 'all');
  await rowAction(sam, 'maya', 'Message');
  await sam.say('Thanks for the invite!');
  await maya.until(`window.__notes.some(n => n.title === 'sam' && n.body === 'Thanks for the invite!')`, 'DM notification');
  await maya.until(`[...document.querySelectorAll('#inbox .badge')].length === 1`, 'inbox badge');
  assert(!(await leo.js(`return document.body.textContent.includes('Thanks for the invite')`)), 'leo cannot see the DM');
  await background(maya, false);
  console.log('✓ direct message arrives with a desktop notification, only for maya');
  await sam.say('See you Saturday 👋');
  await maya.js(`$('msg').blur()`);
  await maya.shot('chat.png');
  await nav(maya, 'sam');
  await maya.until(`$('log').textContent.includes('See you Saturday')`, 'DM thread');
  await maya.js(`$('msg').blur()`);
  await maya.shot('dm.png');
  await nav(maya, 'Friends'); await tab(maya, 'online');
  // A notification while blacked out would give privatewebchat away, so there are none
  await maya.js(`PwcPanic()`);
  await background(maya, true);
  const before = await maya.js(`return window.__notes.length`);
  await sam.say('Are you there?');
  await sleep(1200);
  assert.strictEqual(await maya.js(`return window.__notes.length`), before, 'no notifications while blacked out');
  await maya.fill('#blackPin', '1234');
  await maya.js(`$('blackPin').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await maya.until(`$('black').classList.contains('hidden')`, 'back');
  await background(maya, false);
  console.log('✓ no notifications while blacked out');

  // ── Settings, profile, safety numbers ──
  await maya.click('#settingsBtn');
  await maya.until(`$('modalCard').textContent.includes('Black-out key')`, 'settings');
  await maya.js(`for (const b of document.querySelectorAll('#modalCard b')) if (b.textContent.includes('127.0.0.1')) b.textContent = 'your-privatewebchat.onrender.com'`);
  await maya.size(1100, 980);
  await maya.shot('settings.png');
  await maya.size(1100, 700);
  await maya.clickText('Close');
  await nav(maya, 'Weekend plans');
  for (const t of ['Matrix', 'Amber', 'Midnight']) {
    await pickTheme(maya, t);
    await maya.js(`$('msg').blur()`);
    await maya.shot(`theme-${t.toLowerCase()}.png`);
  }
  await pickTheme(maya, 'Kali');
  console.log('✓ themes switch from Settings → Appearance');
  await nav(maya, 'Friends'); await tab(maya, 'all');
  await maya.js(`[...document.querySelectorAll('#friendsBody .frow')].find(r => r.querySelector('.who b').textContent === 'sam').click()`);
  await maya.until(`$('modalCard').textContent.includes('Invited by')`, 'profile');
  await maya.shot('profile.png');
  await maya.clickText('Verify safety number');
  await maya.until(`$('modalCard').textContent.includes('Safety number for')`, 'safety number');
  const theirs = await maya.js(`return document.querySelector('#modalCard .box').textContent`);
  await maya.clickText('Close');
  await sam.click('#settingsBtn');
  await sam.until(`$('modalCard').textContent.includes('Your safety number')`, 'sam settings');
  const samOwn = await sam.js(`return [...document.querySelectorAll('#modalCard .box')].pop().textContent`);
  await sam.clickText('Close');
  assert.strictEqual(theirs, samOwn, 'safety numbers match on both sides');
  console.log('✓ safety numbers match');

  // ── Black-out key ──
  await nav(maya, 'Weekend plans');
  await maya.key('Escape', 'Escape', 27);
  await maya.until(`!$('black').classList.contains('hidden') && $('app').classList.contains('hidden')`, 'black-out');
  await maya.fill('#blackPin', '0000');
  await maya.js(`$('blackPin').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(900);
  assert(await maya.js(`return !$('black').classList.contains('hidden')`), 'wrong PIN keeps it black');
  await maya.fill('#blackPin', '1234');
  await maya.js(`$('blackPin').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await maya.until(`$('black').classList.contains('hidden') && !$('sMain').classList.contains('hidden')`, 'back from black-out');
  console.log('✓ black-out key hides everything; only the PIN brings it back');

  // ── PIN on launch ──
  await maya.reload();
  await maya.until(`!$('sUnlock').classList.contains('hidden')`, 'unlock screen');
  await maya.fill('#unlockPin', '9999');
  await maya.click('#unlockGo');
  await maya.until(`$('unlockErr').textContent === 'Wrong PIN'`, 'wrong PIN');
  await maya.fill('#unlockPin', '1234');
  await maya.shot('unlock.png');
  await maya.click('#unlockGo');
  await maya.until(`!$('sMain').classList.contains('hidden')`, 'unlocked');
  await online(maya);
  await nav(maya, 'Weekend plans');
  assert((await lastMsg(maya)).includes('see you there'), 'history survives a restart');
  await tab(maya, 'all'); await nav(maya, 'Friends');
  assert(await maya.js(`return $('friendsBody').textContent.includes('leo')`), 'friends survive a restart');
  console.log('✓ PIN required on launch, history and friends kept');

  // ── Usernames are unique ──
  const code3 = await invite(maya);
  await maya.clickText('Close');
  const dup = await newPage('dup');
  await dup.size(1100, 700);
  await dup.goto(url);
  await dup.until(`!$('sWelcome').classList.contains('hidden')`, 'welcome');
  await dup.click('#goJoin');
  await dup.fill('#joinCode', code3); await dup.fill('#joinName', 'SAM');
  await dup.until(`$('joinFrom').textContent.includes('Invite from')`, 'invite check');
  await dup.click('#joinNext');
  await setPin(dup, '1357');
  await dup.until(`$('modalCard').dataset.kind === 'rename'`, 'username taken');
  await dup.fill('#modalCard input', 'ana');
  await dup.clickText('Use this username');
  await online(dup);
  console.log('✓ a taken username is refused and the new member picks another');

  // ── The theme is remembered, even on the lock screen ──
  await pickTheme(leo, 'Matrix');
  await leo.reload();
  await leo.until(`!$('sUnlock').classList.contains('hidden')`, 'leo unlock screen');
  assert.strictEqual(await leo.js(`return document.documentElement.dataset.theme`), 'matrix', 'theme kept on the lock screen');
  await leo.fill('#unlockPin', '2468');
  await leo.click('#unlockGo');
  await leo.until(`!$('sMain').classList.contains('hidden')`, 'leo unlocked');
  await online(leo);
  console.log('✓ theme remembered across restarts, including the lock screen');

  // ── Wipe PIN ──
  await leo.click('#settingsBtn');
  await leo.until(`$('modalCard').textContent.includes('Wipe PIN')`, 'settings');
  await leo.fill('#modalCard input[placeholder="Current PIN"]', '2468');
  await leo.fill('#modalCard input[placeholder="Wipe PIN"]', '2468');
  await leo.fill('#modalCard input[placeholder="Wipe PIN again"]', '2468');
  await leo.clickText('Set wipe PIN');
  await leo.until(`$('modalCard').textContent.includes("can't be the same")`, 'same as PIN refused');
  await leo.fill('#modalCard input[placeholder="Current PIN"]', '2468');
  await leo.fill('#modalCard input[placeholder="Wipe PIN"]', '0000');
  await leo.fill('#modalCard input[placeholder="Wipe PIN again"]', '0000');
  await leo.clickText('Set wipe PIN');
  await leo.until(`$('modalCard').textContent.includes('Wipe PIN set')`, 'wipe PIN set');
  await leo.clickText('Close');
  await leo.js(`PwcPanic()`);
  await leo.fill('#blackPin', '0000');
  await leo.js(`$('blackPin').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await sleep(1500);
  await leo.until(`!$('sWelcome').classList.contains('hidden')`, 'fresh install after wipe');
  assert.strictEqual(await leo.js(`return sessionStorage.length`), 0, 'nothing left after wipe');
  assert.strictEqual(await leo.js(`return document.documentElement.dataset.theme`), 'kali', 'wipe resets the theme');
  console.log('✓ wipe PIN erases everything and privatewebchat opens as new');

  // ── Removing a member ──
  await nav(maya, 'Friends'); await tab(maya, 'all');
  await maya.js(`[...document.querySelectorAll('#friendsBody .frow')].find(r => r.querySelector('.who b').textContent === 'sam').click()`);
  await maya.clickText('Remove from network');
  await maya.clickText('Remove');
  await sam.until(`!$('sGone').classList.contains('hidden')`, 'sam removed');
  console.log('✓ owner removed a member, who was disconnected');

  console.log('\nAll UI tests passed');
  for (const p of procs) p.kill();
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); for (const p of procs) p.kill(); process.exit(1); });
