// Mac side of platform.h: files in ~/Library/Application Support/Hush, the device secret in the
// Keychain, the background panic key through Carbon hot keys, and the menu bar (without an Edit
// menu, Cmd+C and Cmd+V don't work in the web view). Cocoa is called through the Objective-C
// runtime so this stays plain C.
#include "platform.h"
#include <Carbon/Carbon.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

// ──────────── Files ────────────
static char dir[1024];
static const char *data_dir(void) {
  if (!dir[0]) {
    const char *home = getenv("HOME");
    snprintf(dir, sizeof dir, "%s/Library/Application Support/Hush", home ? home : ".");
    mkdir(dir, 0700);
  }
  return dir;
}
static void path_for(const char *name, char *out, size_t n) { snprintf(out, n, "%s/%s", data_dir(), name); }

char *plat_read(const char *name, size_t *len) {
  char p[1200];
  path_for(name, p, sizeof p);
  FILE *f = fopen(p, "rb");
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
  char p[1200], tmp[1210];
  path_for(name, p, sizeof p);
  snprintf(tmp, sizeof tmp, "%s.tmp", p);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return -1;
  while (len) {
    ssize_t k = write(fd, data, len);
    if (k < 0 && errno == EINTR) continue;
    if (k <= 0) { close(fd); unlink(tmp); return -1; }
    data += k; len -= (size_t)k;
  }
  fsync(fd);
  close(fd);
  return rename(tmp, p);
}
void plat_remove(const char *name) {
  char p[1200];
  path_for(name, p, sizeof p);
  unlink(p);
}
void plat_random(void *buf, size_t n) { arc4random_buf(buf, n); }
long long plat_now_ms(void) {
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (long long)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}

// ──────────── Device secret (Keychain) ────────────
// If the Keychain can't be used at all, the secret falls back to a file only this user can read.
static CFMutableDictionaryRef kc_query(void) {
  CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(q, kSecAttrService, CFSTR("Hush"));
  CFDictionarySetValue(q, kSecAttrAccount, CFSTR("device-secret"));
  return q;
}
int plat_device_secret(unsigned char out[32], int *created) {
  *created = 0;
  CFMutableDictionaryRef q = kc_query();
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef res = NULL;
  OSStatus st = SecItemCopyMatching(q, &res);
  CFRelease(q);
  if (st == errSecSuccess && res && CFGetTypeID(res) == CFDataGetTypeID() && CFDataGetLength(res) == 32) {
    memcpy(out, CFDataGetBytePtr(res), 32);
    CFRelease(res);
    return 0;
  }
  if (res) CFRelease(res);
  size_t n = 0;
  char *f = plat_read("device.key", &n);
  if (f && n == 32) { memcpy(out, f, 32); memset(f, 0, n); free(f); return 0; }
  free(f);
  if (st != errSecItemNotFound) return -1;   // there is a secret, but the Keychain wouldn't hand it over
  plat_random(out, 32);
  CFMutableDictionaryRef add = kc_query();
  CFDataRef data = CFDataCreate(NULL, out, 32);
  CFDictionarySetValue(add, kSecValueData, data);
  st = SecItemAdd(add, NULL);
  CFRelease(data); CFRelease(add);
  if (st != errSecSuccess && plat_write("device.key", (const char *)out, 32)) return -1;
  *created = 1;
  return 0;
}
void plat_forget_device_secret(void) {
  CFMutableDictionaryRef q = kc_query();
  SecItemDelete(q);
  CFRelease(q);
  plat_remove("device.key");
}

// ──────────── Objective-C runtime helpers ────────────
static SEL S(const char *n) { return sel_registerName(n); }
static id C(const char *n) { return (id)objc_getClass(n); }
static id msg0(id o, const char *s) { return ((id (*)(id, SEL))objc_msgSend)(o, S(s)); }
static id msg1(id o, const char *s, id a) { return ((id (*)(id, SEL, id))objc_msgSend)(o, S(s), a); }
static id str(const char *s) { return ((id (*)(id, SEL, const char *))objc_msgSend)(C("NSString"), S("stringWithUTF8String:"), s); }
static id app(void) { return msg0(C("NSApplication"), "sharedApplication"); }
static id menu(const char *title) { return msg1(msg0(C("NSMenu"), "alloc"), "initWithTitle:", str(title)); }
static void add_item(id m, const char *title, const char *action, const char *key) {
  id it = ((id (*)(id, SEL, id, SEL, id))objc_msgSend)(msg0(C("NSMenuItem"), "alloc"), S("initWithTitle:action:keyEquivalent:"),
    str(title), action ? S(action) : (SEL)0, str(key));
  msg1(m, "addItem:", it);
}
static void add_submenu(id bar, id sub) {
  id it = msg0(msg0(C("NSMenuItem"), "alloc"), "init");
  msg1(it, "setSubmenu:", sub);
  msg1(bar, "addItem:", it);
}

void plat_init(void *window) {
  (void)window;
  id bar = menu("");
  id appm = menu("Hush");
  add_item(appm, "Hide Hush", "hide:", "h");
  add_item(appm, "Quit Hush", "terminate:", "q");
  id edit = menu("Edit");
  add_item(edit, "Undo", "undo:", "z");
  add_item(edit, "Redo", "redo:", "Z");
  add_item(edit, "Cut", "cut:", "x");
  add_item(edit, "Copy", "copy:", "c");
  add_item(edit, "Paste", "paste:", "v");
  add_item(edit, "Select All", "selectAll:", "a");
  id win = menu("Window");
  add_item(win, "Minimize", "performMiniaturize:", "m");
  add_submenu(bar, appm);
  add_submenu(bar, edit);
  add_submenu(bar, win);
  msg1(app(), "setMainMenu:", bar);
}
void plat_attention(void) { ((long (*)(id, SEL, unsigned long))objc_msgSend)(app(), S("requestUserAttention:"), 10); }
void plat_copy(const char *text) {
  id pb = msg0(C("NSPasteboard"), "generalPasteboard");
  ((long (*)(id, SEL))objc_msgSend)(pb, S("clearContents"));
  ((BOOL (*)(id, SEL, id, id))objc_msgSend)(pb, S("setString:forType:"), str(text), str("public.utf8-plain-text"));
}
void plat_fatal(const char *msg) { fprintf(stderr, "%s\n", msg); }

// ──────────── Notifications (UserNotifications framework) ────────────
// Only works when running as Hush.app: a bare binary has no bundle identifier, and the framework
// refuses to run without one.
static id center(void) {
  if (!msg0(msg0(C("NSBundle"), "mainBundle"), "bundleIdentifier")) return nil;
  return msg0(C("UNUserNotificationCenter"), "currentNotificationCenter");
}
void plat_notify_setup(void) {
  id c = center();
  if (!c) return;
  // UNAuthorizationOptionSound | UNAuthorizationOptionAlert
  ((void (*)(id, SEL, unsigned long, void (^)(BOOL, id)))objc_msgSend)(c, S("requestAuthorizationWithOptions:completionHandler:"),
    (1 << 1) | (1 << 2), ^(BOOL granted, id error) { (void)granted; (void)error; });
}
void plat_notify(const char *title, const char *body) {
  id c = center();
  if (!c) return;
  id content = msg0(msg0(C("UNMutableNotificationContent"), "alloc"), "init");
  msg1(content, "setTitle:", str(title));
  msg1(content, "setBody:", str(body));
  msg1(content, "setSound:", msg0(C("UNNotificationSound"), "defaultSound"));
  id uuid = msg0(msg0(C("NSUUID"), "UUID"), "UUIDString");
  id req = ((id (*)(id, SEL, id, id, id))objc_msgSend)(C("UNNotificationRequest"), S("requestWithIdentifier:content:trigger:"), uuid, content, nil);
  ((void (*)(id, SEL, id, void (^)(id)))objc_msgSend)(c, S("addNotificationRequest:withCompletionHandler:"), req, ^(id error) { (void)error; });
}
void plat_shutdown(void) {}

// ──────────── Background panic key ────────────
static const struct { const char *code; UInt32 key; } KEYS[] = {
  { "KeyA", kVK_ANSI_A }, { "KeyB", kVK_ANSI_B }, { "KeyC", kVK_ANSI_C }, { "KeyD", kVK_ANSI_D }, { "KeyE", kVK_ANSI_E },
  { "KeyF", kVK_ANSI_F }, { "KeyG", kVK_ANSI_G }, { "KeyH", kVK_ANSI_H }, { "KeyI", kVK_ANSI_I }, { "KeyJ", kVK_ANSI_J },
  { "KeyK", kVK_ANSI_K }, { "KeyL", kVK_ANSI_L }, { "KeyM", kVK_ANSI_M }, { "KeyN", kVK_ANSI_N }, { "KeyO", kVK_ANSI_O },
  { "KeyP", kVK_ANSI_P }, { "KeyQ", kVK_ANSI_Q }, { "KeyR", kVK_ANSI_R }, { "KeyS", kVK_ANSI_S }, { "KeyT", kVK_ANSI_T },
  { "KeyU", kVK_ANSI_U }, { "KeyV", kVK_ANSI_V }, { "KeyW", kVK_ANSI_W }, { "KeyX", kVK_ANSI_X }, { "KeyY", kVK_ANSI_Y },
  { "KeyZ", kVK_ANSI_Z }, { "Digit0", kVK_ANSI_0 }, { "Digit1", kVK_ANSI_1 }, { "Digit2", kVK_ANSI_2 }, { "Digit3", kVK_ANSI_3 },
  { "Digit4", kVK_ANSI_4 }, { "Digit5", kVK_ANSI_5 }, { "Digit6", kVK_ANSI_6 }, { "Digit7", kVK_ANSI_7 }, { "Digit8", kVK_ANSI_8 },
  { "Digit9", kVK_ANSI_9 }, { "F1", kVK_F1 }, { "F2", kVK_F2 }, { "F3", kVK_F3 }, { "F4", kVK_F4 }, { "F5", kVK_F5 },
  { "F6", kVK_F6 }, { "F7", kVK_F7 }, { "F8", kVK_F8 }, { "F9", kVK_F9 }, { "F10", kVK_F10 }, { "F11", kVK_F11 },
  { "F12", kVK_F12 }, { "F13", kVK_F13 }, { "F14", kVK_F14 }, { "F15", kVK_F15 }, { "F16", kVK_F16 }, { "F17", kVK_F17 },
  { "F18", kVK_F18 }, { "F19", kVK_F19 }, { "F20", kVK_F20 }, { "Escape", kVK_Escape }, { "Backquote", kVK_ANSI_Grave },
  { "Minus", kVK_ANSI_Minus }, { "Equal", kVK_ANSI_Equal }, { "BracketLeft", kVK_ANSI_LeftBracket },
  { "BracketRight", kVK_ANSI_RightBracket }, { "Backslash", kVK_ANSI_Backslash }, { "Semicolon", kVK_ANSI_Semicolon },
  { "Quote", kVK_ANSI_Quote }, { "Comma", kVK_ANSI_Comma }, { "Period", kVK_ANSI_Period }, { "Slash", kVK_ANSI_Slash },
  { "Space", kVK_Space }, { "Tab", kVK_Tab }, { "Delete", kVK_ForwardDelete }, { "Home", kVK_Home }, { "End", kVK_End },
  { "PageUp", kVK_PageUp }, { "PageDown", kVK_PageDown }, { "ArrowLeft", kVK_LeftArrow }, { "ArrowRight", kVK_RightArrow },
  { "ArrowUp", kVK_UpArrow }, { "ArrowDown", kVK_DownArrow },
};
static EventHotKeyRef hot;
static void (*hot_fn)(void);
static int handler_installed;
static OSStatus on_hot(EventHandlerCallRef next, EventRef ev, void *ud) {
  (void)next; (void)ev; (void)ud;
  if (hot_fn) hot_fn();
  return noErr;
}
int plat_set_hotkey(const char *code, void (*fn)(void)) {
  if (hot) { UnregisterEventHotKey(hot); hot = NULL; }
  hot_fn = fn;
  if (!code || !*code) return 0;
  if (!handler_installed) {
    EventTypeSpec spec = { kEventClassKeyboard, kEventHotKeyPressed };
    InstallApplicationEventHandler(NewEventHandlerUPP(on_hot), 1, &spec, NULL, NULL);
    handler_installed = 1;
  }
  for (size_t i = 0; i < sizeof KEYS / sizeof KEYS[0]; i++) {
    if (strcmp(KEYS[i].code, code)) continue;
    EventHotKeyID hid = { 'HUSH', 1 };
    return RegisterEventHotKey(KEYS[i].key, 0, hid, GetApplicationEventTarget(), 0, &hot) == noErr;
  }
  return 0;
}
