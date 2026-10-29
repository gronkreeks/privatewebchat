// Windows side of platform.h: files in %APPDATA%\privatewebchat, the device secret protected with DPAPI
// (only this Windows account can decrypt it), and the background panic key through RegisterHotKey.
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#define _WIN32_IE 0x0700
#include "platform.h"
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <wincrypt.h>
#include <urlmon.h>

#define PATH_MAX_W 1024

// ──────────── Files ────────────
static wchar_t dir[PATH_MAX_W];
static const wchar_t *data_dir(void) {
  if (!dir[0]) {
    const wchar_t *base = _wgetenv(L"APPDATA");
    wcsncpy(dir, base ? base : L".", PATH_MAX_W - 8);
    wcscat(dir, L"\\privatewebchat");
    CreateDirectoryW(dir, NULL);
  }
  return dir;
}
static void path_for(const char *name, const char *suffix, wchar_t *out) {
  char full[256];
  snprintf(full, sizeof full, "\\%s%s", name, suffix);
  wcscpy(out, data_dir());
  size_t n = wcslen(out);
  MultiByteToWideChar(CP_UTF8, 0, full, -1, out + n, (int)(PATH_MAX_W - n));
}

char *plat_read(const char *name, size_t *len) {
  wchar_t p[PATH_MAX_W];
  path_for(name, "", p);
  FILE *f = _wfopen(p, L"rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = n >= 0 ? malloc((size_t)n + 1) : NULL;
  if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); fclose(f); return NULL; }
  fclose(f);
  buf[n] = 0;
  if (len) *len = (size_t)n;
  return buf;
}
int plat_write(const char *name, const char *data, size_t len) {
  wchar_t p[PATH_MAX_W], tmp[PATH_MAX_W];
  path_for(name, "", p);
  path_for(name, ".tmp", tmp);
  FILE *f = _wfopen(tmp, L"wb");
  if (!f) return -1;
  int ok = fwrite(data, 1, len, f) == len;
  ok = fflush(f) == 0 && ok;
  fclose(f);
  if (!ok || !MoveFileExW(tmp, p, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) { DeleteFileW(tmp); return -1; }
  return 0;
}
void plat_remove(const char *name) {
  wchar_t p[PATH_MAX_W];
  path_for(name, "", p);
  DeleteFileW(p);
}
void plat_random(void *buf, size_t n) { BCryptGenRandom(NULL, (PUCHAR)buf, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG); }
long long plat_now_ms(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  return (long long)((t - 116444736000000000ULL) / 10000);
}

// ──────────── Device secret (DPAPI) ────────────
int plat_device_secret(unsigned char out[32], int *created) {
  *created = 0;
  size_t n = 0;
  char *blob = plat_read("device.key", &n);
  if (blob) {
    DATA_BLOB in = { (DWORD)n, (BYTE *)blob }, plain = { 0, NULL };
    BOOL ok = CryptUnprotectData(&in, NULL, NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &plain);
    free(blob);
    // A key file that won't decrypt was made by another Windows account or computer
    if (!ok || plain.cbData != 32) { if (ok) LocalFree(plain.pbData); return -1; }
    memcpy(out, plain.pbData, 32);
    SecureZeroMemory(plain.pbData, plain.cbData);
    LocalFree(plain.pbData);
    return 0;
  }
  plat_random(out, 32);
  DATA_BLOB in = { 32, out }, sealed = { 0, NULL };
  if (!CryptProtectData(&in, L"privatewebchat", NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &sealed)) return -1;
  int r = plat_write("device.key", (const char *)sealed.pbData, sealed.cbData);
  LocalFree(sealed.pbData);
  if (r) return -1;
  *created = 1;
  return 0;
}
void plat_forget_device_secret(void) { plat_remove("device.key"); }

// ──────────── Window ────────────
static HWND hw;
static WNDPROC orig_proc;
static void (*hot_fn)(void);
static int hot_on;
static void (*hide_fn)(void);
static int quitting;
#define WM_TRAY (WM_APP + 1)
#define TRAY_OPEN 1
#define TRAY_QUIT 2
static int tray_add(void);
static void show_window(HWND h) {
  ShowWindow(h, IsIconic(h) ? SW_RESTORE : SW_SHOW);
  SetForegroundWindow(h);
}
static void tray_menu(HWND h) {
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, TRAY_OPEN, L"Open privatewebchat");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, TRAY_QUIT, L"Quit privatewebchat");
  SetMenuDefaultItem(m, TRAY_OPEN, FALSE);
  POINT p;
  GetCursorPos(&p);
  SetForegroundWindow(h);   // otherwise the menu doesn't go away when clicking elsewhere
  int cmd = TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, p.x, p.y, 0, h, NULL);
  DestroyMenu(m);
  if (cmd == TRAY_OPEN) show_window(h);
  else if (cmd == TRAY_QUIT) { quitting = 1; PostMessageW(h, WM_CLOSE, 0, 0); }
}
static LRESULT CALLBACK proc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  if (m == WM_HOTKEY && wp == 1) { if (hot_fn) hot_fn(); return 0; }
  // Closing the window only hides it in the tray, until Quit in the tray icon's menu
  if (m == WM_CLOSE && hide_fn && !quitting) {
    hide_fn();
    ShowWindow(h, SW_HIDE);
    return 0;
  }
  // Clicking a notification or the tray icon brings privatewebchat back; right-click for the menu
  if (m == WM_TRAY) {
    UINT ev = LOWORD(lp);
    if (ev == NIN_BALLOONUSERCLICK || ev == WM_LBUTTONUP) show_window(h);
    else if (ev == WM_RBUTTONUP || ev == WM_CONTEXTMENU) tray_menu(h);
    return 0;
  }
  // Explorer restarted: the tray icon has to be added again
  static UINT taskbar_created;
  if (!taskbar_created) taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
  if (m == taskbar_created && hide_fn) { tray_add(); return 0; }
  return CallWindowProcW(orig_proc, h, m, wp, lp);
}
// The app icon from win/app.rc, at a given size (falls back to the standard one)
static HICON app_icon(int metric) {
  int s = GetSystemMetrics(metric);
  HICON i = (HICON)LoadImageW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(1), IMAGE_ICON, s, s, 0);
  return i ? i : LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);
}
void plat_init(void *window) {
  hw = (HWND)window;
  orig_proc = (WNDPROC)SetWindowLongPtrW(hw, GWLP_WNDPROC, (LONG_PTR)proc);
  SendMessageW(hw, WM_SETICON, ICON_BIG, (LPARAM)app_icon(SM_CXICON));
  SendMessageW(hw, WM_SETICON, ICON_SMALL, (LPARAM)app_icon(SM_CXSMICON));
}
void plat_attention(void) {
  FLASHWINFO fi = { sizeof fi, hw, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0 };
  FlashWindowEx(&fi);
}
void plat_copy(const char *text) {
  int n = MultiByteToWideChar(CP_UTF8, 0, text, -1, NULL, 0);
  if (n <= 0 || !OpenClipboard(hw)) return;
  EmptyClipboard();
  HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, (SIZE_T)n * sizeof(wchar_t));
  if (g) {
    MultiByteToWideChar(CP_UTF8, 0, text, -1, (wchar_t *)GlobalLock(g), n);
    GlobalUnlock(g);
    if (!SetClipboardData(CF_UNICODETEXT, g)) GlobalFree(g);
  }
  CloseClipboard();
}
// ──────────── Notifications ────────────
// A tray icon's notification. Windows 10 and 11 show it as a toast, and unlike toasts it needs no
// installer or Start menu shortcut.
static NOTIFYICONDATAW nid;
static int tray_on;
static void utf8_to(wchar_t *out, int n, const char *s) {
  if (!MultiByteToWideChar(CP_UTF8, 0, s, -1, out, n)) out[0] = 0;
  out[n - 1] = 0;
}
static int tray_add(void) {
  nid.cbSize = sizeof nid;
  nid.hWnd = hw;
  nid.uID = 1;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  nid.uCallbackMessage = WM_TRAY;
  nid.hIcon = app_icon(SM_CXSMICON);
  wcscpy(nid.szTip, L"privatewebchat");
  tray_on = Shell_NotifyIconW(NIM_ADD, &nid) != 0;
  return tray_on;
}
void plat_close_to_tray(void (*on_hide)(void)) {
  hide_fn = on_hide;
  if (hw && !tray_on) tray_add();
}
void plat_notify_setup(void) {}
void plat_notify(const char *title, const char *body) {
  if (!hw) return;
  if (!tray_on && !tray_add()) return;
  nid.uFlags = NIF_INFO;
  nid.dwInfoFlags = NIIF_INFO;
  utf8_to(nid.szInfoTitle, (int)(sizeof nid.szInfoTitle / sizeof(wchar_t)), title);
  utf8_to(nid.szInfo, (int)(sizeof nid.szInfo / sizeof(wchar_t)), body);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}
void plat_shutdown(void) { if (tray_on) { nid.uFlags = 0; Shell_NotifyIconW(NIM_DELETE, &nid); tray_on = 0; } }

char *plat_paste(void) {
  char *out = NULL;
  if (!OpenClipboard(hw)) return NULL;
  HANDLE h = GetClipboardData(CF_UNICODETEXT);
  const wchar_t *w = h ? (const wchar_t *)GlobalLock(h) : NULL;
  if (w) {
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
    if (n > 0 && (out = malloc((size_t)n))) WideCharToMultiByte(CP_UTF8, 0, w, -1, out, n, NULL, NULL);
    GlobalUnlock(h);
  }
  CloseClipboard();
  return out;
}
void plat_fatal(const char *msg) { MessageBoxA(NULL, msg, "privatewebchat", MB_OK | MB_ICONERROR); }

// ──────────── Updates ────────────
int plat_download(const char *url, const char *name) {
  wchar_t p[PATH_MAX_W], part[PATH_MAX_W], wurl[1024];
  path_for(name, "", p);
  path_for(name, ".part", part);
  if (!MultiByteToWideChar(CP_UTF8, 0, url, -1, wurl, 1024)) return -1;
  DeleteFileW(part);
  if (URLDownloadToFileW(NULL, wurl, part, 0, NULL) != S_OK || !MoveFileExW(part, p, MOVEFILE_REPLACE_EXISTING)) { DeleteFileW(part); return -1; }
  return 0;
}
int plat_sha256(const char *name, unsigned char out[32]) {
  wchar_t p[PATH_MAX_W];
  path_for(name, "", p);
  FILE *f = _wfopen(p, L"rb");
  if (!f) return -1;
  BCRYPT_ALG_HANDLE alg = NULL;
  BCRYPT_HASH_HANDLE hh = NULL;
  int ok = BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) == 0 && BCryptCreateHash(alg, &hh, NULL, 0, NULL, 0, 0) == 0;
  static unsigned char buf[65536];
  size_t n;
  while (ok && (n = fread(buf, 1, sizeof buf, f)) > 0) ok = BCryptHashData(hh, buf, (ULONG)n, 0) == 0;
  ok = ok && !ferror(f) && BCryptFinishHash(hh, out, 32, 0) == 0;
  fclose(f);
  if (hh) BCryptDestroyHash(hh);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  return ok ? 0 : -1;
}
// A running .exe can't be overwritten but it can be renamed: this one moves aside to privatewebchat.exe.old
// (deleted at the next start), the new one takes its place and starts, and this one quits.
static void exe_paths(wchar_t *exe, wchar_t *old) {
  GetModuleFileNameW(NULL, exe, PATH_MAX_W);
  swprintf(old, PATH_MAX_W, L"%ls.old", exe);
}
int plat_update_install(const char *name) {
  wchar_t exe[PATH_MAX_W], old[PATH_MAX_W], upd[PATH_MAX_W];
  exe_paths(exe, old);
  path_for(name, "", upd);
  DeleteFileW(old);
  if (MoveFileExW(exe, old, MOVEFILE_REPLACE_EXISTING)) {
    if (MoveFileExW(upd, exe, MOVEFILE_COPY_ALLOWED | MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      STARTUPINFOW si = { sizeof si };
      PROCESS_INFORMATION pi;
      if (CreateProcessW(exe, NULL, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
      return 0;
    }
    MoveFileExW(old, exe, 0);
  }
  // privatewebchat's folder can't be written to: show the download so it can be swapped in by hand
  wchar_t args[PATH_MAX_W + 16];
  swprintf(args, PATH_MAX_W + 16, L"/select,\"%ls\"", upd);
  ShellExecuteW(NULL, L"open", L"explorer.exe", args, NULL, SW_SHOWNORMAL);
  return 1;
}
// The old copy may still be quitting when the new one starts, so keep trying for a little while
static DWORD WINAPI cleanup_loop(LPVOID arg) {
  wchar_t *old = arg;
  for (int i = 0; i < 40 && GetFileAttributesW(old) != INVALID_FILE_ATTRIBUTES && !DeleteFileW(old); i++) Sleep(500);
  free(old);
  return 0;
}
void plat_update_cleanup(void) {
  wchar_t exe[PATH_MAX_W], *old = malloc(PATH_MAX_W * sizeof(wchar_t));
  if (!old) return;
  exe_paths(exe, old);
  HANDLE t = GetFileAttributesW(old) != INVALID_FILE_ATTRIBUTES ? CreateThread(NULL, 0, cleanup_loop, old, 0, NULL) : NULL;
  if (t) CloseHandle(t); else free(old);
}

// ──────────── Background panic key ────────────
static UINT vk_for(const char *c) {
  if (!strncmp(c, "Key", 3) && c[3] >= 'A' && c[3] <= 'Z' && !c[4]) return (UINT)c[3];
  if (!strncmp(c, "Digit", 5) && c[5] >= '0' && c[5] <= '9' && !c[6]) return (UINT)c[5];
  if (c[0] == 'F' && c[1] >= '1' && c[1] <= '9' && (!c[2] || (c[2] >= '0' && c[2] <= '9' && !c[3]))) {
    int n = atoi(c + 1);
    if (n >= 1 && n <= 24) return VK_F1 + (UINT)(n - 1);
  }
  static const struct { const char *code; UINT vk; } T[] = {
    { "Escape", VK_ESCAPE }, { "Backquote", VK_OEM_3 }, { "Minus", VK_OEM_MINUS }, { "Equal", VK_OEM_PLUS },
    { "BracketLeft", VK_OEM_4 }, { "BracketRight", VK_OEM_6 }, { "Backslash", VK_OEM_5 }, { "Semicolon", VK_OEM_1 },
    { "Quote", VK_OEM_7 }, { "Comma", VK_OEM_COMMA }, { "Period", VK_OEM_PERIOD }, { "Slash", VK_OEM_2 },
    { "Space", VK_SPACE }, { "Tab", VK_TAB }, { "Insert", VK_INSERT }, { "Delete", VK_DELETE }, { "Home", VK_HOME },
    { "End", VK_END }, { "PageUp", VK_PRIOR }, { "PageDown", VK_NEXT }, { "ArrowLeft", VK_LEFT },
    { "ArrowRight", VK_RIGHT }, { "ArrowUp", VK_UP }, { "ArrowDown", VK_DOWN }, { "Pause", VK_PAUSE },
    { "ScrollLock", VK_SCROLL },
  };
  for (size_t i = 0; i < sizeof T / sizeof T[0]; i++) if (!strcmp(T[i].code, c)) return T[i].vk;
  return 0;
}
int plat_set_hotkey(const char *code, void (*fn)(void)) {
  if (hot_on) { UnregisterHotKey(hw, 1); hot_on = 0; }
  hot_fn = fn;
  if (!code || !*code || !hw) return 0;
  UINT vk = vk_for(code);
  if (!vk) return 0;
  hot_on = RegisterHotKey(hw, 1, MOD_NOREPEAT, vk) != 0;
  return hot_on;
}
