// Hush local storage. Everything this device keeps (your keys, members, rooms, messages and
// settings) is one AES-GCM blob in vault.json. Its key comes from PBKDF2 over your PIN together
// with a device secret kept in the Mac Keychain or Windows DPAPI, so a copied vault file can't be
// cracked by guessing PINs elsewhere. The wipe PIN is checked against a separate hash stored next
// to the blob. When no wipe PIN is set, that hash is random, so the file doesn't show whether one exists.
const Vault = (() => {
  const ITER = 600000;
  const te = new TextEncoder(), td = new TextDecoder();
  const { toB64, fromB64 } = HushProto;
  const rand = n => crypto.getRandomValues(new Uint8Array(n));
  let header = null;    // what's in vault.json
  let key = null;       // AES-GCM key for the blob, only while unlocked
  let pinHash = null;   // hash of the PIN-derived key, to check the PIN again on the black screen
  let secret = null;    // device secret
  let data = null;
  let saveT = null, saving = Promise.resolve();

  async function deviceSecret() {
    if (secret) return secret;
    const r = await window.hush_device_secret();
    if (!r) throw new Error('keychain');
    secret = r;
    return r;
  }
  async function derive(pin, salt) {
    const s = await deviceSecret();
    const base = await crypto.subtle.importKey('raw', te.encode(pin + '|' + s.secret), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(salt), iterations: header.iter || ITER }, base, 256));
  }
  const sha = async bytes => toB64(await crypto.subtle.digest('SHA-256', bytes));
  const sameText = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
  const keyFrom = bits => crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function load() {
    const s = await window.hush_read_vault();
    header = null;
    if (s) { try { header = JSON.parse(s); } catch (e) { header = null; } }
    return !!header;
  }
  // The vault exists but its device secret was just made: the old one is gone, so it can never open
  async function orphaned() { const s = await deviceSecret(); return !!header && s.created; }

  async function write() {
    const k = key;
    if (!k) return;
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(JSON.stringify(data)));
    if (key !== k) return;   // locked or wiped meanwhile
    header = { ...header, iv: toB64(iv), ct: toB64(ct) };
    if (!(await window.hush_write_vault(JSON.stringify(header)))) throw new Error("Couldn't save");
  }
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => { saving = saving.then(write).catch(e => console.error(e)); }, 400);
  }
  function saveNow() { clearTimeout(saveT); saving = saving.then(write); return saving; }

  async function create(pin, initial) {
    header = { v: 1, iter: ITER, salt: toB64(rand(16)), wsalt: toB64(rand(16)), whash: toB64(rand(32)) };
    const bits = await derive(pin, header.salt);
    key = await keyFrom(bits); pinHash = await sha(bits); data = initial;
    await saveNow();
  }
  // 'ok', 'wipe' (the wipe PIN was entered) or 'wrong'
  async function unlock(pin) {
    const bits = await derive(pin, header.salt);
    const wipe = await isWipePin(pin);
    try {
      const k = await keyFrom(bits);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(header.iv) }, k, fromB64(header.ct));
      data = JSON.parse(td.decode(pt)); key = k; pinHash = await sha(bits);
      return 'ok';
    } catch (e) { return wipe ? 'wipe' : 'wrong'; }
  }
  async function isWipePin(pin) { return sameText(await sha(await derive(pin, header.wsalt)), header.whash); }
  async function check(pin) {
    const [bits, wipe] = await Promise.all([derive(pin, header.salt), isWipePin(pin)]);
    if (sameText(await sha(bits), pinHash)) return 'ok';
    return wipe ? 'wipe' : 'wrong';
  }
  async function setPin(pin) {
    if (await isWipePin(pin)) throw new Error("Your PIN can't be the same as your wipe PIN");
    header = { ...header, salt: toB64(rand(16)) };
    const bits = await derive(pin, header.salt);
    key = await keyFrom(bits); pinHash = await sha(bits);
    await saveNow();
  }
  async function setWipePin(pin) {
    const wsalt = toB64(rand(16));
    let whash = toB64(rand(32));
    if (pin) {
      const bits = await derive(pin, header.salt);
      if (sameText(await sha(bits), pinHash)) throw new Error("Your wipe PIN can't be the same as your PIN");
      header = { ...header, wsalt };
      whash = await sha(await derive(pin, wsalt));
    }
    header = { ...header, wsalt, whash };
    data.settings.wipeSet = !!pin;
    await saveNow();
  }
  function lock() { clearTimeout(saveT); key = null; pinHash = null; data = null; return saving.catch(() => { }); }

  return { load, orphaned, create, unlock, check, setPin, setWipePin, save, saveNow, lock, get data() { return data; }, get exists() { return !!header; } };
})();
