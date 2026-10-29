// The server every copy of the app connects to. Change it here (and rebuild) to move servers. The
// Content-Security-Policy in index.html names it too, so the app can ping it awake (app.js wake()).
// VERSION has to match app/mac/Info.plist and app/win/app.rc (tests/version.test.js checks). When
// privatewebchat opens it compares it with the newest release at UPDATES and updates itself.
const PwcConfig = {
  SERVER: 'wss://privatewebchat.onrender.com',
  VERSION: '1.1.5',
  UPDATES: 'https://api.github.com/repos/gronkreeks/privatewebchat/releases',
};
if (typeof module === 'object' && module.exports) module.exports = PwcConfig;
