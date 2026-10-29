#!/bin/sh
# Cross-builds dist/privatewebchat.exe on a Mac or Linux with MinGW (brew install mingw-w64), plus
# dist/privatewebchat-windows.zip with the same .exe inside, for people who'd rather download a zip.
set -e
cd "$(dirname "$0")"
mkdir -p build dist
WV2=build/webview2/build/native/include
if [ ! -f "$WV2/WebView2.h" ]; then
  curl -sSL -o build/webview2.zip https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.4258.31
  mkdir -p build/webview2 && (cd build/webview2 && unzip -oq ../webview2.zip)
fi
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css config.js protocol.js vault.js app.js
CC=x86_64-w64-mingw32-gcc CXX=x86_64-w64-mingw32-g++
FLAGS="-O2 -DWEBVIEW_STATIC -Ivendor/webview -Ibuild -Isrc"
$CXX $FLAGS -std=c++17 -w -I$WV2 -c src/webview.cc -o build/webview-win.o
$CC $FLAGS -std=gnu11 -c src/main.c -o build/main-win.o
$CC $FLAGS -std=gnu11 -c src/platform_win.c -o build/platform_win.o
x86_64-w64-mingw32-windres --include-dir=. win/app.rc -O coff -o build/app-res.o
$CXX -static -mwindows -o dist/privatewebchat.exe build/webview-win.o build/main-win.o build/platform_win.o build/app-res.o \
  -lws2_32 -lbcrypt -lcrypt32 -ladvapi32 -lole32 -lshell32 -lshlwapi -luser32 -lversion
rm -f dist/privatewebchat-windows.zip
(cd dist && zip -q -X privatewebchat-windows.zip privatewebchat.exe)
ls -lh dist/privatewebchat.exe dist/privatewebchat-windows.zip
