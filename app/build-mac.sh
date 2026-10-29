#!/bin/sh
# Builds privatewebchat.app for Apple Silicon and Intel Macs, plus dist/privatewebchat-mac.zip to share.
# Needs the Xcode command line tools (xcode-select --install).
set -e
cd "$(dirname "$0")"
mkdir -p build dist
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css config.js protocol.js vault.js app.js
ARCH="-arch arm64 -arch x86_64 -mmacosx-version-min=11.0"
FLAGS="$ARCH -O2 -DWEBVIEW_STATIC -Ivendor/webview -Ibuild -Isrc"
clang++ $FLAGS -std=c++14 -w -c src/webview.cc -o build/webview.o
clang $FLAGS -std=gnu11 -Wall -c src/main.c -o build/main.o
clang $FLAGS -std=gnu11 -Wall -Wno-multichar -Wno-deprecated-declarations -c src/platform_mac.c -o build/platform_mac.o
clang++ $ARCH build/webview.o build/main.o build/platform_mac.o -o build/privatewebchat \
  -framework WebKit -framework Cocoa -framework Security -framework Carbon -framework UserNotifications
rm -rf dist/privatewebchat.app
mkdir -p dist/privatewebchat.app/Contents/MacOS dist/privatewebchat.app/Contents/Resources
cp icons/icon.icns dist/privatewebchat.app/Contents/Resources/icon.icns
cp mac/Info.plist dist/privatewebchat.app/Contents/
cp build/privatewebchat dist/privatewebchat.app/Contents/MacOS/privatewebchat
codesign --force --deep -s - dist/privatewebchat.app
rm -f dist/privatewebchat-mac.zip
(cd dist && ditto -c -k --keepParent privatewebchat.app privatewebchat-mac.zip)
ls -lh dist/privatewebchat-mac.zip
