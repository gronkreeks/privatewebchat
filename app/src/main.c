// privatewebchat desktop app. A small C program that opens the system web view (WKWebView on Mac,
// WebView2 on Windows) and shows the privatewebchat UI, which is built into the program (ui.h, made by
// embed.c from the files in ui/). The UI is served from 127.0.0.1 on a random port and a secret
// path, because WebCrypto only runs on secure origins and loopback counts as one.
// The UI encrypts everything it stores before handing it to these functions.
#define __USE_MINGW_ANSI_STDIO 1
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "webview/webview.h"
#include "platform.h"
#include "ui.h"

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET sock_t;
#define close_sock closesocket
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
typedef int sock_t;
#define INVALID_SOCKET (-1)
#define close_sock close
#endif

#ifndef PWC_DEBUG
#define PWC_DEBUG 0
#endif

#define VAULT "vault.json"
#define ATTEMPTS "attempts.txt"

static webview_t w;

// ──────────── Serving the UI on 127.0.0.1 ────────────
static sock_t listener = INVALID_SOCKET;
static char token[33];
static int port;

static void send_all(sock_t s, const char *p, size_t n) {
  while (n) {
    int k = send(s, p, (int)(n > 65536 ? 65536 : n), 0);
    if (k <= 0) return;
    p += k; n -= (size_t)k;
  }
}
static void serve_one(sock_t c) {
  char req[8192];
  size_t n = 0;
  while (n < sizeof req - 1) {
    int k = recv(c, req + n, (int)(sizeof req - 1 - n), 0);
    if (k <= 0) break;
    n += (size_t)k; req[n] = 0;
    if (strstr(req, "\r\n\r\n")) break;
  }
  req[n] = 0;
  // GET /<token>/<file> HTTP/1.1
  const struct ui_file *f = NULL;
  char prefix[40];
  snprintf(prefix, sizeof prefix, "GET /%s/", token);
  if (!strncmp(req, prefix, strlen(prefix))) {
    const char *p = req + strlen(prefix);
    size_t len = strcspn(p, " ?#");
    if (!len) { p = "index.html"; len = strlen(p); }
    for (size_t i = 0; i < ui_count; i++)
      if (strlen(ui_files[i].path) == len && !strncmp(ui_files[i].path, p, len)) f = &ui_files[i];
  }
  char head[512];
  if (!f) {
    const char *nf = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    send_all(c, nf, strlen(nf));
  } else {
    snprintf(head, sizeof head,
      "HTTP/1.1 200 OK\r\nContent-Type: %s\r\nContent-Length: %zu\r\nCache-Control: no-store\r\n"
      "X-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n", f->type, f->len);
    send_all(c, head, strlen(head));
    send_all(c, (const char *)f->data, f->len);
  }
  close_sock(c);
}
#ifdef _WIN32
static DWORD WINAPI serve_loop(LPVOID arg) {
#else
static void *serve_loop(void *arg) {
#endif
  (void)arg;
  for (;;) {
    sock_t c = accept(listener, NULL, NULL);
    if (c == INVALID_SOCKET) continue;
#ifdef _WIN32
    DWORD tmo = 5000;
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, (const char *)&tmo, sizeof tmo);
#else
    struct timeval tmo = { 5, 0 };
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tmo, sizeof tmo);
#endif
    serve_one(c);
  }
  return 0;
}
static int serve_start(void) {
#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa)) return -1;
#endif
  unsigned char r[16];
  plat_random(r, sizeof r);
  for (int i = 0; i < 16; i++) snprintf(token + i * 2, 3, "%02x", r[i]);
  listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener == INVALID_SOCKET) return -1;
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t alen = sizeof a;
  if (bind(listener, (struct sockaddr *)&a, sizeof a) || listen(listener, 16) || getsockname(listener, (struct sockaddr *)&a, &alen)) return -1;
  port = ntohs(a.sin_port);
#ifdef _WIN32
  HANDLE t = CreateThread(NULL, 0, serve_loop, NULL, 0, NULL);
  if (!t) return -1;
  CloseHandle(t);
#else
  pthread_t t;
  if (pthread_create(&t, NULL, serve_loop, NULL)) return -1;
  pthread_detach(t);
#endif
  return 0;
}

// ──────────── JSON for bindings ────────────
// Binding arguments arrive as a JSON array, and results go back as JSON.
static const char *skip_ws(const char *p) { while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++; return p; }
static int hexval(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
static unsigned read_u4(const char *p) {
  unsigned v = 0;
  for (int i = 0; i < 4; i++) { int h = hexval(p[i]); if (h < 0) return 0xFFFD; v = v * 16 + (unsigned)h; }
  return v;
}
static char *put_utf8(char *o, unsigned cp) {
  if (cp < 0x80) *o++ = (char)cp;
  else if (cp < 0x800) { *o++ = (char)(0xC0 | cp >> 6); *o++ = (char)(0x80 | (cp & 0x3F)); }
  else if (cp < 0x10000) { *o++ = (char)(0xE0 | cp >> 12); *o++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *o++ = (char)(0x80 | (cp & 0x3F)); }
  else { *o++ = (char)(0xF0 | cp >> 18); *o++ = (char)(0x80 | ((cp >> 12) & 0x3F)); *o++ = (char)(0x80 | ((cp >> 6) & 0x3F)); *o++ = (char)(0x80 | (cp & 0x3F)); }
  return o;
}
// The JSON string between s (just after the opening quote) and e (the closing quote), unescaped
static char *unescape(const char *s, const char *e) {
  char *out = malloc((size_t)(e - s) + 1), *o = out;
  if (!out) return NULL;
  while (s < e) {
    if (*s != '\\') { *o++ = *s++; continue; }
    s++;
    switch (*s) {
      case 'n': *o++ = '\n'; s++; break;
      case 'r': *o++ = '\r'; s++; break;
      case 't': *o++ = '\t'; s++; break;
      case 'b': *o++ = '\b'; s++; break;
      case 'f': *o++ = '\f'; s++; break;
      case 'u': {
        if (e - s < 5) { s = e; break; }
        unsigned cp = read_u4(s + 1);
        s += 5;
        if (cp >= 0xD800 && cp < 0xDC00 && e - s >= 6 && s[0] == '\\' && s[1] == 'u') {
          unsigned lo = read_u4(s + 2);
          if (lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); s += 6; }
        }
        o = put_utf8(o, cp);
        break;
      }
      default: *o++ = *s++; break;   // \" \\ \/
    }
  }
  *o = 0;
  return out;
}
// The index-th element of a JSON array: strings come back unescaped, anything else as written.
// Returns a malloc'd string, or NULL if there's no such element.
static char *json_arg(const char *req, int index) {
  const char *p = skip_ws(req);
  if (*p++ != '[') return NULL;
  for (int i = 0;; i++) {
    p = skip_ws(p);
    if (!*p || *p == ']') return NULL;
    if (*p == '"') {
      const char *q = p + 1;
      while (*q && *q != '"') { if (*q == '\\' && q[1]) q++; q++; }
      if (!*q) return NULL;
      if (i == index) return unescape(p + 1, q);
      p = q + 1;
    } else {
      const char *start = p;
      int depth = 0;
      while (*p && !(depth == 0 && (*p == ',' || *p == ']'))) {
        if (*p == '[' || *p == '{') depth++;
        else if (*p == ']' || *p == '}') depth--;
        else if (*p == '"') { p++; while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; } if (!*p) return NULL; }
        p++;
      }
      if (i == index) {
        const char *e = p;
        while (e > start && (e[-1] == ' ' || e[-1] == '\n' || e[-1] == '\r' || e[-1] == '\t')) e--;
        char *out = malloc((size_t)(e - start) + 1);
        if (out) { memcpy(out, start, (size_t)(e - start)); out[e - start] = 0; }
        return out;
      }
    }
    p = skip_ws(p);
    if (*p == ',') p++;
  }
}
static char *json_quote(const char *s, size_t n) {
  char *out = malloc(n * 6 + 3), *o = out;
  if (!out) return NULL;
  *o++ = '"';
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { *o++ = '\\'; *o++ = (char)c; }
    else if (c < 0x20) o += sprintf(o, "\\u%04x", c);
    else *o++ = (char)c;
  }
  *o++ = '"'; *o = 0;
  return out;
}
static int arg_true(const char *req, int index) {
  char *a = json_arg(req, index);
  int t = a && !strcmp(a, "true");
  free(a);
  return t;
}
static void ret(const char *id, const char *json) { webview_return(w, id, 0, json); }

// ──────────── Bindings the UI calls ────────────
static void b_read_vault(const char *id, const char *req, void *arg) {
  (void)req; (void)arg;
  size_t n;
  char *s = plat_read(VAULT, &n);
  if (!s) { ret(id, "null"); return; }
  char *q = json_quote(s, n);
  ret(id, q ? q : "null");
  free(q); free(s);
}
static void b_write_vault(const char *id, const char *req, void *arg) {
  (void)arg;
  char *s = json_arg(req, 0);
  int ok = s && plat_write(VAULT, s, strlen(s)) == 0;
  ret(id, ok ? "true" : "false");
  free(s);
}
static void b_device_secret(const char *id, const char *req, void *arg) {
  (void)req; (void)arg;
  static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  unsigned char k[33] = { 0 };
  int created = 0;
  if (plat_device_secret(k, &created)) { ret(id, "null"); return; }
  char b[48], out[96];
  int j = 0;
  for (int i = 0; i < 33; i += 3) {   // 32 bytes plus one zero byte: the last group is trimmed below
    unsigned v = (unsigned)k[i] << 16 | (unsigned)k[i + 1] << 8 | (unsigned)k[i + 2];
    b[j++] = B64[v >> 18 & 63]; b[j++] = B64[v >> 12 & 63]; b[j++] = B64[v >> 6 & 63]; b[j++] = B64[v & 63];
  }
  b[43] = '='; b[44] = 0;
  snprintf(out, sizeof out, "{\"secret\":\"%s\",\"created\":%s}", b, created ? "true" : "false");
  ret(id, out);
  memset(k, 0, sizeof k); memset(b, 0, sizeof b); memset(out, 0, sizeof out);
}
// Wrong PINs: after 5 in a row each try waits 30 seconds, doubling up to an hour
static void read_attempts(int *fails, long long *until) {
  *fails = 0; *until = 0;
  char *s = plat_read(ATTEMPTS, NULL);
  if (s) { sscanf(s, "%d %lld", fails, until); free(s); }
}
static void b_pin_start(const char *id, const char *req, void *arg) {
  (void)req; (void)arg;
  int fails; long long until;
  read_attempts(&fails, &until);
  long long wait = until - plat_now_ms();
  char out[32];
  snprintf(out, sizeof out, "%lld", wait > 0 ? wait : 0);
  ret(id, out);
}
static void b_pin_result(const char *id, const char *req, void *arg) {
  (void)arg;
  int fails; long long until;
  read_attempts(&fails, &until);
  if (arg_true(req, 0)) { fails = 0; until = 0; }
  else if (++fails >= 5) {
    int shift = fails - 5 > 7 ? 7 : fails - 5;
    long long wait = 30000LL << shift;
    until = plat_now_ms() + (wait > 3600000 ? 3600000 : wait);
  }
  char s[64];
  snprintf(s, sizeof s, "%d %lld", fails, until);
  plat_write(ATTEMPTS, s, strlen(s));
  ret(id, "null");
}
// Deleting the device secret is what makes the wipe final: without it, a copy of the vault
// recovered from the disk can't be decrypted even with the PIN.
static void b_wipe(const char *id, const char *req, void *arg) {
  (void)req; (void)arg;
  plat_set_hotkey(NULL, NULL);
  plat_forget_device_secret();
  plat_remove(VAULT);
  plat_remove(VAULT ".tmp");
  plat_remove(ATTEMPTS);
  ret(id, "true");
}
static void on_hotkey(void) { webview_eval(w, "window.PwcPanic && window.PwcPanic()"); }
static void b_set_panic(const char *id, const char *req, void *arg) {
  (void)arg;
  char *code = json_arg(req, 0);
  int ok = 0;
  if (code && arg_true(req, 1)) ok = plat_set_hotkey(code, on_hotkey);
  else plat_set_hotkey(NULL, NULL);
  ret(id, ok ? "true" : "false");
  free(code);
}
static void b_attention(const char *id, const char *req, void *arg) { (void)req; (void)arg; plat_attention(); ret(id, "null"); }
static void b_paste(const char *id, const char *req, void *arg) {
  (void)req; (void)arg;
  char *t = plat_paste();
  char *q = t ? json_quote(t, strlen(t)) : NULL;
  ret(id, q ? q : "null");
  free(q); free(t);
}
static void b_notify_setup(const char *id, const char *req, void *arg) { (void)req; (void)arg; plat_notify_setup(); ret(id, "null"); }
static void b_notify(const char *id, const char *req, void *arg) {
  (void)arg;
  char *title = json_arg(req, 0), *body = json_arg(req, 1);
  if (title && body) plat_notify(title, body);
  free(title); free(body);
  ret(id, "null");
}
static void b_title(const char *id, const char *req, void *arg) {
  (void)arg;
  char *t = json_arg(req, 0);
  if (t) webview_set_title(w, t);
  free(t);
  ret(id, "null");
}
static void b_copy(const char *id, const char *req, void *arg) {
  (void)arg;
  char *t = json_arg(req, 0);
  if (t) plat_copy(t);
  free(t);
  ret(id, "null");
}

static void after_start(webview_t wv, void *arg) { (void)arg; plat_init(webview_get_window(wv)); }

#ifdef PWC_SELFTEST
// Test builds only (tools/selftest.sh): checks WebCrypto, the bindings and WebSocket inside the
// real web view, prints the result and quits.
static void b_selftest_done(const char *id, const char *req, void *arg) {
  (void)arg;
  char *r = json_arg(req, 0);
  printf("SELFTEST %s\n", r ? r : "null");
  printf("MENU %s\n", plat_debug_menu());
  fflush(stdout);
  free(r);
  ret(id, "null");
  webview_terminate(w);
}
static const char *SELFTEST_JS =
  "window.addEventListener('load', async () => {"
  "  const r = { secure: isSecureContext, subtle: !!(window.crypto && crypto.subtle) };"
  "  try {"
  "    const k = await PwcProto.generateKeys(); r.keys = !!k.sigPub;"
  "    const c = await PwcProto.ownerCert(k, 'Test'); r.cert = !!(await PwcProto.verifyCert(c, k.sigPub));"
  "    const b = await crypto.subtle.importKey('raw', new TextEncoder().encode('1234'), 'PBKDF2', false, ['deriveBits']);"
  "    const t = performance.now();"
  "    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(16), iterations: 600000 }, b, 256);"
  "    r.pbkdf2ms = Math.round(performance.now() - t);"
  "  } catch (e) { r.err = String(e); }"
  "  r.pinWait = await pwc_pin_start();"
  "  r.clipboard = String(await pwc_paste() || '').slice(0, 5);"
  "  r.screen = [...document.querySelectorAll('section')].filter(s => !s.classList.contains('hidden')).map(s => s.id).join();"
  "  const url = new URLSearchParams(location.hash.slice(1)).get('ws');"
  "  if (url) await new Promise(res => { const ws = new WebSocket(url); ws.onmessage = e => { r.ws = JSON.parse(e.data).t; ws.close(); res(); };"
  "    ws.onerror = () => { r.ws = 'error'; res(); }; setTimeout(res, 8000); });"
  "  const code = new URLSearchParams(location.hash.slice(1)).get('invite');"
  "  if (code) { const t = document.getElementById('joinCode'); t.value = code; t.dispatchEvent(new Event('input'));"
  "    await new Promise(res => setTimeout(res, 1500));"
  "    r.inviteErr = document.getElementById('joinErr').textContent;"
  "    r.usernameShown = !document.getElementById('joinMore').classList.contains('hidden');"
  "    try { const s = code.replace(/\\s+/g, ''); const inv = JSON.parse(atob(s.slice(5).replace(/-/g, '+').replace(/_/g, '/')));"
  "      const c = inv.g.from; r.certOk = !!(await PwcProto.verifyCert(c, c.m.sig));"
  "      r.sigOk = await PwcProto.verify(c.m.sig, ['pwc-invite', inv.g.ik, inv.g.exp], inv.g.s);"
  "    } catch (e) { r.inviteEx = String(e); } }"
  "  pwc_selftest_done(JSON.stringify(r));"
  "});";
#endif

int main(void) {
#ifndef _WIN32
  signal(SIGPIPE, SIG_IGN);
#endif
  if (serve_start()) { plat_fatal("privatewebchat couldn't start."); return 1; }
  w = webview_create(PWC_DEBUG, NULL);
  if (!w) {
#ifdef _WIN32
    plat_fatal("privatewebchat needs the Microsoft Edge WebView2 Runtime. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and open privatewebchat again.");
#else
    plat_fatal("privatewebchat couldn't open its window.");
#endif
    return 1;
  }
  webview_set_title(w, "privatewebchat");
  webview_set_size(w, 760, 520, WEBVIEW_HINT_MIN);
  webview_set_size(w, 1100, 720, WEBVIEW_HINT_NONE);
  webview_bind(w, "pwc_read_vault", b_read_vault, NULL);
  webview_bind(w, "pwc_write_vault", b_write_vault, NULL);
  webview_bind(w, "pwc_device_secret", b_device_secret, NULL);
  webview_bind(w, "pwc_pin_start", b_pin_start, NULL);
  webview_bind(w, "pwc_pin_result", b_pin_result, NULL);
  webview_bind(w, "pwc_wipe", b_wipe, NULL);
  webview_bind(w, "pwc_set_panic", b_set_panic, NULL);
  webview_bind(w, "pwc_attention", b_attention, NULL);
  webview_bind(w, "pwc_title", b_title, NULL);
  webview_bind(w, "pwc_copy", b_copy, NULL);
  webview_bind(w, "pwc_paste", b_paste, NULL);
  webview_bind(w, "pwc_notify_setup", b_notify_setup, NULL);
  webview_bind(w, "pwc_notify", b_notify, NULL);
  webview_dispatch(w, after_start, NULL);
  char url[512];
  snprintf(url, sizeof url, "http://127.0.0.1:%d/%s/index.html", port, token);
#ifdef PWC_SELFTEST
  webview_bind(w, "pwc_selftest_done", b_selftest_done, NULL);
  webview_init(w, SELFTEST_JS);
  static char big[4096];
  snprintf(big, sizeof big, "%s#ws=%s&invite=%s", url, getenv("PWC_SELFTEST_WS") ? getenv("PWC_SELFTEST_WS") : "", getenv("PWC_SELFTEST_INVITE") ? getenv("PWC_SELFTEST_INVITE") : "");
#endif
#ifdef PWC_SELFTEST
  webview_navigate(w, big);
#else
  webview_navigate(w, url);
#endif
  webview_run(w);
  plat_set_hotkey(NULL, NULL);
  plat_shutdown();
  webview_destroy(w);
  return 0;
}
