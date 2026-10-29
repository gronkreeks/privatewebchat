#!/bin/sh
# Builds Hush.app for Apple Silicon and Intel Macs, plus dist/Hush-mac.zip to share.
# Needs the Xcode command line tools (xcode-select --install).
set -e
cd "$(dirname "$0")"
mkdir -p build dist
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css protocol.js vault.js app.js
ARCH="-arch arm64 -arch x86_64 -mmacosx-version-min=11.0"
FLAGS="$ARCH -O2 -DWEBVIEW_STATIC -Ivendor/webview -Ibuild -Isrc"
clang++ $FLAGS -std=c++14 -w -c src/webview.cc -o build/webview.o
clang $FLAGS -std=gnu11 -Wall -c src/main.c -o build/main.o
clang $FLAGS -std=gnu11 -Wall -Wno-multichar -Wno-deprecated-declarations -c src/platform_mac.c -o build/platform_mac.o
clang++ $ARCH build/webview.o build/main.o build/platform_mac.o -o build/Hush \
  -framework WebKit -framework Cocoa -framework Security -framework Carbon -framework UserNotifications
rm -rf dist/Hush.app
mkdir -p dist/Hush.app/Contents/MacOS
cp mac/Info.plist dist/Hush.app/Contents/
cp build/Hush dist/Hush.app/Contents/MacOS/Hush
codesign --force --deep -s - dist/Hush.app
rm -f dist/Hush-mac.zip
(cd dist && ditto -c -k --keepParent Hush.app Hush-mac.zip)
ls -lh dist/Hush-mac.zip
