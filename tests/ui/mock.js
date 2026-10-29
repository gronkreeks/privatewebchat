// Stand-ins for the native bindings, so the UI can be tested in a normal browser.
// The "vault file" lives in sessionStorage, which survives a reload of the page like a real file.
(() => {
  const get = k => sessionStorage.getItem('mock-' + k), set = (k, v) => sessionStorage.setItem('mock-' + k, v);
  window.pwc_read_vault = async () => get('vault');
  window.pwc_write_vault = async s => { set('vault', s); return true; };
  window.pwc_device_secret = async () => {
    if (get('secret')) return { secret: get('secret'), created: false };
    const s = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    set('secret', s);
    return { secret: s, created: true };
  };
  window.pwc_pin_start = async () => 0;
  window.pwc_pin_result = async () => null;
  window.pwc_wipe = async () => { sessionStorage.clear(); return true; };
  window.pwc_set_panic = async () => true;
  window.pwc_attention = async () => null;
  window.pwc_title = async t => { document.title = t; };
  window.pwc_copy = async t => { window.__copied = t; };
  window.pwc_paste = async () => window.__clipboard || null;
  window.pwc_owner_key = async () => window.__ownerKey || null;
})();
// Desktop notifications are recorded so the test can check them
window.__notes = [];
window.pwc_notify_setup = async () => null;
window.pwc_notify = async (title, body) => { window.__notes.push({ title, body }); };
// Updates: what the app asked for is recorded; a test can make the download fail
window.pwc_update = async tag => { window.__update = tag; return sessionStorage.getItem('mock-updfail') ? { err: 'The download failed.' } : { ok: true }; };
window.pwc_update_install = async () => { window.__installed = true; return 'quit'; };
