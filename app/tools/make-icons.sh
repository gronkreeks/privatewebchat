#!/bin/sh
# Mac only: renders icons/icon.svg into icons/icon.icns (Mac) and icons/icon.ico (Windows).
# Needs Google Chrome for the rendering. The results are committed, so builds don't need this.
set -e
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
T=$(mktemp -d)
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 \
  --user-data-dir="$T/chrome" --screenshot="$T/mac.png" --window-size=1024,1024 "file://$PWD/icons/icon.svg" 2>/dev/null
# Windows icons fill their square, so crop away the Mac grid's margin
sips -c 828 828 "$T/mac.png" --out "$T/win.png" >/dev/null
mkdir -p "$T/icon.iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$T/mac.png" --out "$T/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$T/mac.png" --out "$T/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$T/icon.iconset" -o icons/icon.icns
for s in 16 24 32 48 64 128 256; do sips -z $s $s "$T/win.png" --out "$T/win-$s.png" >/dev/null; done
# An .ico is a small directory of PNGs
python3 - "$T" <<'PY'
import struct, sys
t = sys.argv[1]
sizes = [16, 24, 32, 48, 64, 128, 256]
pngs = [open(f"{t}/win-{s}.png", "rb").read() for s in sizes]
out = struct.pack("<HHH", 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
for s, data in zip(sizes, pngs):
    out += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
    offset += len(data)
open("icons/icon.ico", "wb").write(out + b"".join(pngs))
PY
cp "$T/mac.png" icons/icon.png
rm -rf "$T"
ls -lh icons
