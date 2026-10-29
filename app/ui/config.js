// The server every copy of the app connects to. Change it here (and rebuild) to move servers. The
// Content-Security-Policy in index.html names it too, so the app can ping it awake (app.js wake()).
const PwcConfig = { SERVER: 'wss://privatewebchat.onrender.com' };
if (typeof module === 'object' && module.exports) module.exports = PwcConfig;
