// The version in app/ui/config.js (what the app compares with the newest release when it opens) has
// to match the one the Mac and Windows builds are stamped with. Run: node tests/version.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const v = require('../app/ui/config.js').VERSION;
assert(/^\d+\.\d+\.\d+$/.test(v), 'config.js has a version');
const plist = [...read('app/mac/Info.plist').matchAll(/<key>CFBundleShortVersionString<\/key><string>([^<]+)/g)].map(m => m[1]);
const helpers = [...read('app/build-mac.sh').matchAll(/<key>CFBundleShortVersionString<\/key><string>([^<]+)/g)].map(m => m[1]);
const rc = read('app/win/app.rc');
const rcText = [...rc.matchAll(/VALUE "(?:File|Product)Version", "([^"]+)"/g)].map(m => m[1]);
const rcNum = [...rc.matchAll(/^(?:FILE|PRODUCT)VERSION (\d+),(\d+),(\d+),0/gm)].map(m => m.slice(1).join('.'));
for (const [where, found] of [['Info.plist', plist], ['build-mac.sh', helpers], ['app.rc', rcText], ['app.rc numbers', rcNum]]) {
  assert(found.length, `${where} has a version`);
  for (const f of found) assert.strictEqual(f, v, `${where} says ${f}, config.js says ${v}`);
}
console.log(`version ${v} matches everywhere`);
