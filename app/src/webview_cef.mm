// Mac only: the webview C API that main.c uses, built on Chromium (CEF, vendor/cef-*) instead of
// WKWebView. The window is a plain NSWindow with the browser inside it. Bound functions are
// reached through cef_helper.cc, which runs in Chromium's renderer process: it gives the page one
// function that sends a process message here, and this side answers by running JS in the page.
// Only pages under the UI's own address (127.0.0.1, random port, secret path) get the bindings
// or can be navigated to. Also plat_close_to_tray from platform.h: closing the window hides it and
// the app carries on from the menu bar and Dock until Quit.
#import <Cocoa/Cocoa.h>
#include <crt_externs.h>
#include <string>
#include <vector>
#define WEBVIEW_HEADER
#include "webview/webview.h"
#include "include/cef_app.h"
#include "include/cef_application_mac.h"
#include "include/cef_browser.h"
#include "include/cef_client.h"
#include "include/wrapper/cef_library_loader.h"

namespace {

struct binding { std::string name; void (*fn)(const char *, const char *, void *); void *arg; };
std::vector<binding> bindings;
std::string init_js, prefix;
int debug;
NSWindow *window;
CefRefPtr<CefBrowser> browser;
bool closing, quitting;
void (*hide_fn)(void);
NSStatusItem *tray;

std::string json_str(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}
bool ours(const std::string &url) { return !prefix.empty() && url.compare(0, prefix.size(), prefix) == 0; }

// The page side of the bindings, run by cef_helper.cc before any of the page's own scripts
std::string glue() {
  std::string js =
    "(function () {\n"
    "  const send = window.__pwc_send; delete window.__pwc_send;\n"
    "  if (!send) return;\n"
    "  let seq = 0; const waiting = {};\n"
    "  window.__pwc_reply = (id, status, result) => {\n"
    "    const p = waiting[id]; if (!p) return; delete waiting[id];\n"
    "    status === 0 ? p.resolve(result) : p.reject(result);\n"
    "  };\n"
    "  const bind = name => { window[name] = (...args) => new Promise((resolve, reject) => {\n"
    "    const id = String(++seq); waiting[id] = { resolve, reject }; send(id, name, JSON.stringify(args));\n"
    "  }); };\n";
  for (auto &b : bindings) js += "  bind(" + json_str(b.name) + ");\n";
  return js + "})();\n" + init_js;
}

class Client : public CefClient, public CefLifeSpanHandler, public CefRequestHandler,
               public CefContextMenuHandler, public CefDragHandler {
 public:
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefContextMenuHandler> GetContextMenuHandler() override { return this; }
  CefRefPtr<CefDragHandler> GetDragHandler() override { return this; }

  void OnAfterCreated(CefRefPtr<CefBrowser> b) override {
    browser = b;
    NSView *v = (__bridge NSView *)b->GetHost()->GetWindowHandle();
    v.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    v.frame = window.contentView.bounds;
  }
  // Returning false lets CEF close the window, which comes back through windowShouldClose
  bool DoClose(CefRefPtr<CefBrowser>) override { return false; }
  void OnBeforeClose(CefRefPtr<CefBrowser>) override { browser = nullptr; CefQuitMessageLoop(); }
  bool OnBeforePopup(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, int, const CefString &, const CefString &,
                     WindowOpenDisposition, bool, const CefPopupFeatures &, CefWindowInfo &, CefRefPtr<CefClient> &,
                     CefBrowserSettings &, CefRefPtr<CefDictionaryValue> &, bool *) override { return true; }
  bool OnBeforeBrowse(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefRequest> req, bool, bool) override {
    return !ours(req->GetURL());
  }
  // Files dropped on the window would otherwise replace the app with the file
  bool OnDragEnter(CefRefPtr<CefBrowser>, CefRefPtr<CefDragData>, DragOperationsMask) override { return true; }
  // Only the editing commands, like the WKWebView menu (plus Inspect in debug builds)
  void OnBeforeContextMenu(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame>, CefRefPtr<CefContextMenuParams> params,
                           CefRefPtr<CefMenuModel> model) override {
    if (debug) return;
    if (!(params->GetTypeFlags() & (CM_TYPEFLAG_SELECTION | CM_TYPEFLAG_EDITABLE))) { model->Clear(); return; }
    for (size_t i = model->GetCount(); i-- > 0;) {
      int c = model->GetCommandIdAt(i);
      bool edit = c == MENU_ID_UNDO || c == MENU_ID_REDO || c == MENU_ID_CUT || c == MENU_ID_COPY ||
                  c == MENU_ID_PASTE || c == MENU_ID_DELETE || c == MENU_ID_SELECT_ALL;
      if (!edit && model->GetTypeAt(i) != MENUITEMTYPE_SEPARATOR) model->RemoveAt(i);
    }
    while (model->GetCount() && model->GetTypeAt(0) == MENUITEMTYPE_SEPARATOR) model->RemoveAt(0);
    while (model->GetCount() && model->GetTypeAt(model->GetCount() - 1) == MENUITEMTYPE_SEPARATOR) model->RemoveAt(model->GetCount() - 1);
  }
  bool OnProcessMessageReceived(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, CefProcessId,
                                CefRefPtr<CefProcessMessage> msg) override {
    if (msg->GetName() != "pwc" || !frame->IsMain() || !ours(frame->GetURL())) return false;
    CefRefPtr<CefListValue> a = msg->GetArgumentList();
    std::string id = a->GetString(0), name = a->GetString(1), req = a->GetString(2);
    for (auto &b : bindings)
      if (b.name == name) { b.fn(id.c_str(), req.c_str(), b.arg); return true; }
    return true;
  }
  IMPLEMENT_REFCOUNTING(Client);
};

class App : public CefApp, public CefBrowserProcessHandler {
 public:
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnBeforeCommandLineProcessing(const CefString &, CefRefPtr<CefCommandLine> cl) override {
    cl->AppendSwitch("use-mock-keychain");          // Chromium's own Keychain item isn't needed: nothing is stored
    cl->AppendSwitch("disable-background-networking");
    cl->AppendSwitch("disable-component-update");
    // Keeps the page connected and notifying at full speed while the window is closed to the menu bar
    cl->AppendSwitch("disable-background-timer-throttling");
    cl->AppendSwitch("disable-renderer-backgrounding");
    cl->AppendSwitch("disable-backgrounding-occluded-windows");
  }
  IMPLEMENT_REFCOUNTING(App);
};

class Task : public CefTask {
 public:
  Task(void (*fn)(webview_t, void *), void *arg) : fn_(fn), arg_(arg) {}
  void Execute() override { fn_((webview_t)1, arg_); }
 private:
  void (*fn_)(webview_t, void *);
  void *arg_;
  IMPLEMENT_REFCOUNTING(Task);
};

CefScopedLibraryLoader *loader;
CefRefPtr<Client> client;

}  // namespace

@interface PwcApplication : NSApplication <CefAppProtocol> {
  BOOL handlingSendEvent_;
}
@end
@implementation PwcApplication
- (BOOL)isHandlingSendEvent { return handlingSendEvent_; }
- (void)setHandlingSendEvent:(BOOL)v { handlingSendEvent_ = v; }
- (void)sendEvent:(NSEvent *)e {
  CefScopedSendingEvent sending;
  [super sendEvent:e];
}
// Quit closes the window first, so Chromium shuts down cleanly
- (void)terminate:(id)sender {
  quitting = true;
  if (window) [window performClose:sender]; else [super terminate:sender];
}
@end

@interface PwcWindowDelegate : NSObject <NSWindowDelegate, NSApplicationDelegate>
@end
@implementation PwcWindowDelegate
- (BOOL)windowShouldClose:(NSWindow *)w {
  if (hide_fn && !quitting) {
    hide_fn();
    [w orderOut:nil];
    [NSApp hide:nil];   // so the app isn't frontmost, and notifications show
    return NO;
  }
  if (browser && !closing) { closing = true; browser->GetHost()->CloseBrowser(false); return NO; }
  if (!browser) CefQuitMessageLoop();
  // Taking the browser's view out of the window is what lets CEF finish closing it (OnBeforeClose)
  for (NSView *v in [w.contentView.subviews copy]) [v removeFromSuperview];
  return YES;
}
// Back from the Dock, the menu bar, a notification or the app switcher
- (void)show:(id)sender {
  [NSApp unhide:nil];
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  // The page loses keyboard focus while the window is hidden, so the black-out screen couldn't
  // hear Esc or the PIN until it was clicked
  if (browser) {
    NSView *v = (__bridge NSView *)browser->GetHost()->GetWindowHandle();
    if (v) [window makeFirstResponder:v];
    browser->GetHost()->SetFocus(true);
  }
}
- (void)applicationDidBecomeActive:(NSNotification *)n { if (!quitting && !window.visible) [self show:nil]; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)app hasVisibleWindows:(BOOL)visible {
  if (!visible) [self show:nil];
  return YES;
}
@end
static PwcWindowDelegate *delegate;

extern "C" {

webview_t webview_create(int dbg, void *wnd) {
  (void)wnd;
  debug = dbg;
  [PwcApplication sharedApplication];
  loader = new CefScopedLibraryLoader();
  if (!loader->LoadInMain()) return NULL;
  CefMainArgs args(*_NSGetArgc(), *_NSGetArgv());
  CefSettings s;
  s.no_sandbox = false;
  s.log_severity = debug ? LOGSEVERITY_DEFAULT : LOGSEVERITY_DISABLE;
  s.background_color = 0xFF000000;
  s.remote_debugging_port = debug ? 9222 : 0;
  // Nothing is kept here: the page itself runs with no cache path, so Chromium keeps nothing on disk
  NSString *root = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/privatewebchat/chromium"];
  CefString(&s.root_cache_path) = root.UTF8String;
  if (!CefInitialize(args, s, new App(), nullptr)) return NULL;
  client = new Client();

  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1100, 720)
                                       styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                 NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                         backing:NSBackingStoreBuffered defer:NO];
  delegate = [PwcWindowDelegate new];
  window.delegate = delegate;
  NSApp.delegate = delegate;
  window.releasedWhenClosed = NO;
  window.backgroundColor = NSColor.blackColor;
  [window center];
  return (webview_t)1;
}

webview_error_t webview_set_title(webview_t, const char *title) {
  window.title = [NSString stringWithUTF8String:title];
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_set_size(webview_t, int width, int height, webview_hint_t hints) {
  NSSize sz = NSMakeSize(width, height);
  if (hints == WEBVIEW_HINT_MIN) window.contentMinSize = sz;
  else if (hints == WEBVIEW_HINT_MAX) window.contentMaxSize = sz;
  else {
    [window setContentSize:sz];
    [window center];
    if (hints == WEBVIEW_HINT_FIXED) window.styleMask &= ~NSWindowStyleMaskResizable;
  }
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_bind(webview_t, const char *name, void (*fn)(const char *, const char *, void *), void *arg) {
  for (auto &b : bindings) if (b.name == name) return WEBVIEW_ERROR_DUPLICATE;
  bindings.push_back({ name, fn, arg });
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_init(webview_t, const char *js) {
  init_js += std::string(js) + "\n";
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_eval(webview_t, const char *js) {
  if (browser) browser->GetMainFrame()->ExecuteJavaScript(js, "", 0);
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_return(webview_t w, const char *id, int status, const char *result) {
  std::string js = "window.__pwc_reply && window.__pwc_reply(" + json_str(id) + ", " + std::to_string(status) + ", " +
                   (result && *result ? result : "undefined") + ")";
  return webview_eval(w, js.c_str());
}

// The browser is made on the first navigation, once all the bindings are known
webview_error_t webview_navigate(webview_t, const char *url) {
  std::string u = url;
  prefix = u.substr(0, u.find('/', u.find("://") + 3) + 1);
  size_t tok = u.find('/', prefix.size());
  if (tok != std::string::npos) prefix = u.substr(0, tok + 1);   // http://127.0.0.1:port/<token>/
  if (browser) { browser->GetMainFrame()->LoadURL(url); return WEBVIEW_ERROR_OK; }
  NSRect r = window.contentView.bounds;
  CefWindowInfo info;
  info.SetAsChild((__bridge void *)window.contentView, CefRect(0, 0, (int)r.size.width, (int)r.size.height));
  info.runtime_style = CEF_RUNTIME_STYLE_ALLOY;
  CefBrowserSettings bs;
  bs.background_color = 0xFF000000;
  CefRefPtr<CefDictionaryValue> extra = CefDictionaryValue::Create();
  extra->SetString("glue", glue());
  extra->SetString("prefix", prefix);
  CefBrowserHost::CreateBrowser(info, client, url, bs, extra, nullptr);
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_dispatch(webview_t, void (*fn)(webview_t, void *), void *arg) {
  CefPostTask(TID_UI, new Task(fn, arg));
  return WEBVIEW_ERROR_OK;
}

void *webview_get_window(webview_t) { return (__bridge void *)window; }

webview_error_t webview_run(webview_t) {
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  CefRunMessageLoop();
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_terminate(webview_t) {
  quitting = true;
  [window performClose:nil];
  return WEBVIEW_ERROR_OK;
}

webview_error_t webview_destroy(webview_t) {
  client = nullptr;
  CefShutdown();
  [window close];
  delete loader;
  loader = nullptr;
  return WEBVIEW_ERROR_OK;
}

void plat_close_to_tray(void (*on_hide)(void)) {
  hide_fn = on_hide;
  if (tray) return;
  tray = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
  NSImage *icon = [NSApp.applicationIconImage copy];
  icon.size = NSMakeSize(18, 18);
  tray.button.image = icon;
  tray.button.toolTip = @"privatewebchat";
  NSMenu *m = [NSMenu new];
  [m addItemWithTitle:@"Open privatewebchat" action:@selector(show:) keyEquivalent:@""].target = delegate;
  [m addItem:NSMenuItem.separatorItem];
  [m addItemWithTitle:@"Quit privatewebchat" action:@selector(terminate:) keyEquivalent:@""];
  tray.menu = m;
}

}  // extern "C"
