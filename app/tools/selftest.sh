#!/bin/sh
# Mac only: builds a test copy of privatewebchat, starts a local relay, and checks inside the real
# Chromium window that WebCrypto, the native bindings and WebSocket all work. Prints SELFTEST {...}.
set -e
cd "$(dirname "$0")/.."
PWC_SELFTEST=1 ./build-mac.sh > build/selftest-build.log 2>&1 || { tail -20 build/selftest-build.log; exit 1; }
PORT=18765 node ../server/index.js > build/selftest-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 1
PWC_SELFTEST_WS=ws://127.0.0.1:18765 PWC_SELFTEST_INVITE="$PWC_SELFTEST_INVITE" build/selftest/privatewebchat.app/Contents/MacOS/privatewebchat
