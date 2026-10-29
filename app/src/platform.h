// What privatewebchat needs from the operating system. platform_mac.c and platform_win.c implement it.
#ifndef PWC_PLATFORM_H
#define PWC_PLATFORM_H
#include <stddef.h>

// Files live in privatewebchat's own folder: ~/Library/Application Support/privatewebchat or %APPDATA%\privatewebchat.
// plat_read returns a malloc'd, NUL-terminated copy, or NULL if the file doesn't exist.
char *plat_read(const char *name, size_t *len);
int plat_write(const char *name, const char *data, size_t len);   // replaces the file atomically, 0 on success
void plat_remove(const char *name);

void plat_random(void *buf, size_t n);
long long plat_now_ms(void);

// 32 random bytes that never leave this computer: kept in the Keychain on Mac and protected
// with DPAPI on Windows. *created is set when they were just made. Returns 0 on success.
int plat_device_secret(unsigned char out[32], int *created);
void plat_forget_device_secret(void);

void plat_init(void *window);        // menus and window hooks, once the window exists
// From now on closing the window only hides it: privatewebchat keeps running (and notifying) in the
// tray on Windows and the menu bar and Dock on Mac, until Quit. on_hide runs as the window goes.
// The Mac side is in webview_cef.mm, which owns the window.
void plat_close_to_tray(void (*on_hide)(void));
// A panic key that also works while privatewebchat is in the background. code is a KeyboardEvent.code
// such as "F9" or "Escape"; NULL removes it. Returns 1 if the key was registered.
int plat_set_hotkey(const char *code, void (*fn)(void));
void plat_attention(void);           // bounce the Dock icon / flash the taskbar button
// Desktop notifications: Notification Center on Mac, a tray notification on Windows.
// plat_notify_setup asks for permission the first time (Mac).
void plat_notify_setup(void);
void plat_notify(const char *title, const char *body);
void plat_shutdown(void);            // tidy up (the tray icon) before quitting
void plat_copy(const char *text);
char *plat_paste(void);              // malloc'd clipboard text, or NULL
void plat_fatal(const char *msg);

// Updates (main.c decides what to fetch and checks it). plat_download saves url to a file in
// privatewebchat's folder and blocks until it's done, so it runs on its own thread: 0 on success.
int plat_download(const char *url, const char *name);
int plat_sha256(const char *name, unsigned char out[32]);   // of a file in privatewebchat's folder, 0 on success
// Arranges for the downloaded copy (name, in privatewebchat's folder) to replace this one and start as
// soon as privatewebchat quits: returns 0, and the caller quits. Returns 1 when privatewebchat can't
// replace itself (opened from the disk image, or from a folder it can't write to): the download is
// shown instead, to install by hand.
int plat_update_install(const char *name);
void plat_update_cleanup(void);   // removes what an earlier update left behind (Windows: the old .exe)
#ifdef PWC_SELFTEST
const char *plat_debug_menu(void);
#endif

#endif
