#!/bin/sh
# Puts the newest release's downloads on the EduArcade site, so people can get privatewebchat there
# without going to GitHub: downloads/privatewebchat.dmg and .exe in the site's folder, checked against
# the release's SHA256SUMS.txt. Then commit and push the site.
#   sh tools/site-downloads.sh ~/unblockedarcade [vX.Y.Z]
# The apps update themselves when they open, so the site's copy only needs refreshing now and then.
# Each refresh adds about 100 MB to the site's history. GitHub Pages refuses files over 100 MiB, which
# is why app/build-mac.sh keeps the disk image small.
set -e
SITE=${1:?Usage: sh tools/site-downloads.sh <site folder> [vX.Y.Z]}
TAG=${2:-}
[ -f "$SITE/index.html" ] || { echo "$SITE doesn't look like the site's folder."; exit 1; }
OUT="$SITE/downloads"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh release download $TAG --repo gronkreeks/privatewebchat --dir "$TMP" --pattern privatewebchat.dmg --pattern privatewebchat.exe --pattern SHA256SUMS.txt
(cd "$TMP" && shasum -a 256 -c SHA256SUMS.txt)
SIZE=$(wc -c < "$TMP/privatewebchat.dmg")
[ "$SIZE" -lt 104857600 ] || { echo "The disk image is $SIZE bytes: over GitHub's 100 MiB limit for a file, so it can't go on the site."; exit 1; }
mkdir -p "$OUT"
cp "$TMP/privatewebchat.dmg" "$TMP/privatewebchat.exe" "$TMP/SHA256SUMS.txt" "$OUT/"
ls -lh "$OUT"
echo "\nNow commit and push the site: cd $SITE && git add downloads && git commit -m 'privatewebchat downloads' && git push"
