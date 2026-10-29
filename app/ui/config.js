// The server every copy of the app connects to. Change it here (and rebuild) to move servers.
const PwcConfig = { SERVER: 'wss://privatewebchat.onrender.com' };
if (typeof module === 'object' && module.exports) module.exports = PwcConfig;
