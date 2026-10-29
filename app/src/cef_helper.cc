// Mac only: Chromium's helper processes (renderer, GPU and the rest) for the CEF build. In the
// renderer, every page under the UI's own address gets window.__pwc_send, which passes a binding
// call to webview_cef.mm, and the binding glue that webview_cef.mm sent along runs before the
// page's own scripts.
#include <string>
#include "include/cef_app.h"
#include "include/cef_render_process_handler.h"
#include "include/cef_sandbox_mac.h"
#include "include/cef_v8.h"
#include "include/wrapper/cef_library_loader.h"

namespace {

std::string glue, prefix;

class Send : public CefV8Handler {
 public:
  bool Execute(const CefString &, CefRefPtr<CefV8Value>, const CefV8ValueList &args, CefRefPtr<CefV8Value> &,
               CefString &exception) override {
    if (args.size() != 3 || !args[0]->IsString() || !args[1]->IsString() || !args[2]->IsString()) {
      exception = "bad call";
      return true;
    }
    CefRefPtr<CefProcessMessage> msg = CefProcessMessage::Create("pwc");
    CefRefPtr<CefListValue> a = msg->GetArgumentList();
    for (int i = 0; i < 3; i++) a->SetString(i, args[i]->GetStringValue());
    CefV8Context::GetCurrentContext()->GetFrame()->SendProcessMessage(PID_BROWSER, msg);
    return true;
  }
  IMPLEMENT_REFCOUNTING(Send);
};

class App : public CefApp, public CefRenderProcessHandler {
 public:
  CefRefPtr<CefRenderProcessHandler> GetRenderProcessHandler() override { return this; }
  void OnBrowserCreated(CefRefPtr<CefBrowser>, CefRefPtr<CefDictionaryValue> extra) override {
    if (!extra) return;
    glue = extra->GetString("glue");
    prefix = extra->GetString("prefix");
  }
  void OnContextCreated(CefRefPtr<CefBrowser>, CefRefPtr<CefFrame> frame, CefRefPtr<CefV8Context> ctx) override {
    std::string url = frame->GetURL();
    if (!frame->IsMain() || prefix.empty() || url.compare(0, prefix.size(), prefix)) return;
    ctx->GetGlobal()->SetValue("__pwc_send", CefV8Value::CreateFunction("__pwc_send", new Send()), V8_PROPERTY_ATTRIBUTE_NONE);
    CefRefPtr<CefV8Value> ret;
    CefRefPtr<CefV8Exception> ex;
    ctx->Eval(glue, url, 0, ret, ex);
  }
  IMPLEMENT_REFCOUNTING(App);
};

}  // namespace

int main(int argc, char *argv[]) {
  CefScopedSandboxContext sandbox;
  if (!sandbox.Initialize(argc, argv)) return 1;
  CefScopedLibraryLoader loader;
  if (!loader.LoadInHelper()) return 1;
  CefMainArgs args(argc, argv);
  return CefExecuteProcess(args, new App(), nullptr);
}
