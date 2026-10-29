#!/bin/sh
# Builds privatewebchat.app with Chromium inside (CEF, Chromium Embedded Framework) for Apple Silicon
# Macs, plus dist/privatewebchat-mac.zip to share.
# Needs the Xcode command line tools (xcode-select --install). The first run downloads CEF
# (about 130 MB) into vendor/cef.
# PWC_SELFTEST=1 builds a test copy for this Mac in build/selftest (used by tools/selftest.sh).
set -e
cd "$(dirname "$0")"
CEF=cef_binary_156.0.14+g4fa4ab5+chromium-156.0.8078.48
NAME=privatewebchat
DEFS=""
[ -n "$PWC_SELFTEST" ] && DEFS="-DPWC_SELFTEST"
mkdir -p build dist vendor/cef
cc -O2 -o build/embed src/embed.c
build/embed build/ui.h ui index.html style.css config.js protocol.js vault.js app.js

# A helper app's Info.plist: $1 = name, $2 = bundle id suffix
helper_plist() {
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundleExecutable</key><string>$1</string>
  <key>CFBundleIdentifier</key><string>app.privatewebchat.desktop.helper$2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.1.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
</dict>
</plist>
EOF
}

ARCH=arm64 PLAT=macosarm64 SHA=7359a9d293dd5c480bec3f18b762731b483b0e13
V=vendor/cef/$ARCH
if [ ! -f "$V/include/cef_app.h" ]; then
  echo "Downloading CEF for $ARCH..."
  curl -fL -o "vendor/cef/$PLAT.tar.bz2" "https://cef-builds.spotifycdn.com/$(echo "${CEF}_${PLAT}_minimal.tar.bz2" | sed 's/+/%2B/g')"
  echo "$SHA  vendor/cef/$PLAT.tar.bz2" | shasum -c -
  rm -rf "$V" && mkdir -p "$V"
  tar -xjf "vendor/cef/$PLAT.tar.bz2" -C "$V" --strip-components=1
  rm "vendor/cef/$PLAT.tar.bz2"
fi

B=build/$ARCH
mkdir -p "$B/wrap"
CXX="clang++ -arch $ARCH -mmacosx-version-min=12.0 -O2 -std=c++20 -fno-exceptions -fno-rtti -fno-strict-aliasing
  -fvisibility=hidden -fvisibility-inlines-hidden -fobjc-call-cxx-cdtors -D__STDC_CONSTANT_MACROS -D__STDC_FORMAT_MACROS -DNDEBUG -w"
if [ ! -f "$B/libcef_dll_wrapper.a" ]; then
  echo "Compiling the CEF wrapper for $ARCH..."
  # One compiler per CPU core: each file goes to $0 below, the path inside the CEF folder
  (cd "$V" && find libcef_dll -name '*.cc' -o -name '*.mm') |
    CC1="$CXX -DWRAPPING_CEF_SHARED -I$V" V="$V" W="$B/wrap" xargs -P "$(sysctl -n hw.ncpu)" -n 1 \
      sh -c '$CC1 -c "$V/$0" -o "$W/$(echo "$0" | tr / _).o"'
  ar rcs "$B/libcef_dll_wrapper.a" "$B"/wrap/*.o
fi

FLAGS="-arch $ARCH -mmacosx-version-min=12.0 -O2 $DEFS -DWEBVIEW_STATIC -Ivendor/webview -I$V -Ibuild -Isrc"
$CXX $DEFS -DWEBVIEW_STATIC -Ivendor/webview -I$V -fobjc-arc -c src/webview_cef.mm -o "$B/webview_cef.o"
$CXX -I$V -c src/cef_helper.cc -o "$B/cef_helper.o"
clang $FLAGS -std=gnu11 -Wall -c src/main.c -o "$B/main.o"
clang $FLAGS -std=gnu11 -Wall -Wno-multichar -Wno-deprecated-declarations -c src/platform_mac.c -o "$B/platform_mac.o"
clang++ -arch $ARCH -mmacosx-version-min=12.0 "$B/webview_cef.o" "$B/main.o" "$B/platform_mac.o" "$B/libcef_dll_wrapper.a" -o "$B/$NAME" \
  -framework Cocoa -framework Security -framework Carbon -framework UserNotifications
clang++ -arch $ARCH -mmacosx-version-min=12.0 "$B/cef_helper.o" "$B/libcef_dll_wrapper.a" -o "$B/helper" -framework Cocoa

if [ -n "$PWC_SELFTEST" ]; then OUT=build/selftest; else OUT=dist/mac; fi
APP=$OUT/$NAME.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp icons/icon.icns "$APP/Contents/Resources/icon.icns"
cp mac/Info.plist "$APP/Contents/"
cp "$B/$NAME" "$APP/Contents/MacOS/$NAME"
ditto "$V/Release/Chromium Embedded Framework.framework" "$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
for H in ":" "GPU:.gpu" "Renderer:.renderer" "Plugin:.plugin" "Alerts:.alerts"; do
  KIND=${H%%:*}; SUFFIX=${H#*:}
  HN="$NAME Helper"; [ -n "$KIND" ] && HN="$HN ($KIND)"
  mkdir -p "$APP/Contents/Frameworks/$HN.app/Contents/MacOS"
  cp "$B/helper" "$APP/Contents/Frameworks/$HN.app/Contents/MacOS/$HN"
  helper_plist "$HN" "$SUFFIX" > "$APP/Contents/Frameworks/$HN.app/Contents/Info.plist"
done
for H in "$APP"/Contents/Frameworks/*.app "$APP/Contents/Frameworks/Chromium Embedded Framework.framework"; do
  codesign --force -s - "$H"
done
codesign --force -s - "$APP"
if [ -z "$PWC_SELFTEST" ]; then
  rm -f "dist/$NAME-mac.zip"
  (cd "$OUT" && ditto -c -k --keepParent "$NAME.app" "../$NAME-mac.zip")
  ls -lh "dist/$NAME-mac.zip"
fi
