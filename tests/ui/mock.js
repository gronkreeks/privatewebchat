// Stand-ins for the native bindings, so the UI can be tested in a normal browser.
// The "vault file" lives in sessionStorage, which survives a reload of the page like a real file.
(() => {
  const get = k => sessionStorage.getItem('mock-' + k), set = (k, v) => sessionStorage.setItem('mock-' + k, v);
  window.hush_read_vault = async () => get('vault');
  window.hush_write_vault = async s => { set('vault', s); return true; };
  window.hush_device_secret = async () => {
    if (get('secret')) return { secret: get('secret'), created: false };
    const s = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    set('secret', s);
    return { secret: s, created: true };
  };
  window.hush_pin_start = async () => 0;
  window.hush_pin_result = async () => null;
  window.hush_wipe = async () => { sessionStorage.clear(); return true; };
  window.hush_set_panic = async () => true;
  window.hush_attention = async () => null;
  window.hush_title = async t => { document.title = t; };
  window.hush_copy = async t => { window.__copied = t; };
})();
// Desktop notifications are recorded so the test can check them
window.__notes = [];
window.hush_notify_setup = async () => null;
window.hush_notify = async (title, body) => { window.__notes.push({ title, body }); };
