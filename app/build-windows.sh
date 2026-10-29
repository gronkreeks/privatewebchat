#!/bin/sh
# Cross-builds dist/Hush.exe on a Mac or Linux with MinGW (brew install mingw-w64).
set -e
cd "$(dirname "$0")"
mkdir -p build dist
WV2=build/webview2/build/native/include
if [ ! -f "$WV2/WebView2.h" ]; then
  curl -sSL -o build/webview2.zip https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4258.31
  mkdir -p build/webview2 && (cd build/webview2 && unzip -oq ../webview2.zip)
fi
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css protocol.js vault.js app.js
CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
FLAGS="-O2 -DWEBVIEW_STATIC -Ivendor/webview -Ibuild -Isrc"
$CXX $FLAGS -std=c++17 -w -I$WV2 -c src/webview.cc -o build/webview-win.o
$CC $FLAGS -std=gnu11 -c src/main.c -o build/main-win.o
$CC $FLAGS -std=gnu11 -c src/platform_win.c -o build/platform_win.o
$CXX -static -mwindows -o dist/Hush.exe build/webview-win.o build/main-win.o build/platform_win.o \
  -lws2_32 -lbcrypt -lcrypt32 -ladvapi32 -lole32 -lshell32 -lshlwapi -luser32 -lversion
ls -lh dist/Hush.exe
