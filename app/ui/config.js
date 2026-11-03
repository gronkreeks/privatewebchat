// The server every copy of the app connects to. Change it here (and rebuild) to move servers. The
// Content-Security-Policy in index.html names it too, so the app can ping it awake (app.js wake()).
// VERSION has to match app/mac/Info.plist and app/win/app.rc (tests/version.test.js checks). When
// privatewebchat opens it compares it with the newest release at UPDATES and updates itself.
// OWNER_CERT is the network owner's certificate (public keys only, from tools/owner.js cert): short invite
// codes (PWC2.) leave it out, and the app adds it back from here.
const PwcConfig = {
  SERVER: 'wss://privatewebchat.onrender.com',
  VERSION: '1.1.9',
  OWNER_CERT: {"m":{"name":"developer","sig":"BM67cDODTiG6lHurK1xyU2flms6pLYOZ5XAvqOrylyoaDkLgI1Z1HHQFniqXVuJLSIMNveYlBhWcI+PeFV2oZLM=","ecdh":"BOZWkUy7ItsWeowrwr2JV5gVwNeksUQcsbmarIXRcL48w1cRs34l81gwLGtFPRhQUjKJe66DOejstMt0Z2qYjCE=","at":1793233993890},"s":"tJkC0wy+fl5PRdvyweBB5zjkLx3pIF/osLKDC7Pi8iqZGM6VKGQEgUPQWrtU0sgya9W/TnDViYyYfDHKznBwEA=="},
  UPDATES: 'https://api.github.com/repos/gronkreeks/privatewebchat/releases',
};
if (typeof module === 'object' && module.exports) module.exports = PwcConfig;
