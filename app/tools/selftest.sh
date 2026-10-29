#!/bin/sh
# Mac only: builds a test copy of privatewebchat, starts a local relay, and checks inside the real
# WKWebView that WebCrypto, the native bindings and WebSocket all work. Prints SELFTEST {...}.
set -e
cd "$(dirname "$0")/.."
mkdir -p build
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css protocol.js vault.js app.js
FLAGS="-O2 -DWEBVIEW_STATIC -DPWC_SELFTEST -Ivendor/webview -Ibuild -Isrc"
clang++ $FLAGS -std=c++14 -w -c src/webview.cc -o build/webview-test.o
clang $FLAGS -std=gnu11 -c src/main.c -o build/main-test.o
clang $FLAGS -std=gnu11 -Wno-multichar -Wno-deprecated-declarations -c src/platform_mac.c -o build/platform_mac-test.o
clang++ build/webview-test.o build/main-test.o build/platform_mac-test.o -o build/pwc-selftest \
  -framework WebKit -framework Cocoa -framework Security -framework Carbon -framework UserNotifications
PORT=18765 node ../server/index.js > build/selftest-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
PWC_SELFTEST_WS=ws://127.0.0.1:18765 build/pwc-selftest
