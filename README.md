<div align="center">

<img src="docs/images/logo.svg" width="88" alt="privatewebchat logo">

# privatewebchat

**Private, end-to-end encrypted chat for a group of friends.**<br>
A tiny desktop app for Mac and Windows. Invite only, with a panic black-out key, a wipe PIN and direct messages that delete themselves after 24 hours.

![Mac](https://img.shields.io/badge/macOS-11%2B-000000?logo=apple&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-000000?logo=windows&logoColor=white)
![Size](https://img.shields.io/badge/download-~150%20KB%20(Mac)-367bf0)
![Encryption](https://img.shields.io/badge/encryption-end--to--end-367bf0)

<img src="docs/images/chat.png" width="860" alt="A group chat called Weekend plans in privatewebchat: black background, white text, a Kali-style prompt above the message box">

</div>

---

## Contents

- [Getting in (for friends)](#getting-in-for-friends)
- [What you can do](#what-you-can-do)
- [Screenshots](#screenshots)
- [Themes](#themes)
- [How it works](#how-it-works)
- [Running the server (for the developer)](#running-the-server-for-the-developer)
- [Building from source](#building-from-source)
- [Tests](#tests)
- [Security: what's protected and what isn't](#security-whats-protected-and-what-isnt)
- [Project layout](#project-layout)
- [FAQ](#faq)

## Getting in (for friends)

1. **Download the app** from this repo's [**Releases**](../../releases) page: `privatewebchat-mac.zip` for Mac, `privatewebchat.exe` for Windows.
2. **Open it.** The apps aren't code-signed, so the first launch shows a warning:
   - **Mac:** unzip, then right-click **privatewebchat.app → Open → Open**. On newer macOS: *System Settings → Privacy & Security → Open Anyway*. Allow notifications when asked.
   - **Windows:** in the SmartScreen warning, click **More info → Run anyway**. The app uses the Microsoft Edge WebView2 Runtime, which Windows 10 and 11 normally already have. If it's missing, the app shows the download link.
3. **Paste the invite code** the developer sent you (it starts with `PWC1.`) and pick a username. Usernames are unique and **can't be changed later**.
4. **Choose a PIN.** You'll enter it every time you open the app.

That's it: you're in, on the developer's server. Without an invite code the app doesn't let you in, and each code works for one person only.

<img src="docs/images/welcome.png" width="720" alt="The first screen: paste your invite code and pick a username">

## What you can do

| | |
|---|---|
| **General** | One chat for everyone on the server. |
| **Friends** | Send friend requests by username; accept, decline, remove or block. |
| **Direct messages** | Private chats between friends. **Deleted after 24 hours** on both computers and on the server. |
| **Group chats** | Make a group with any of your friends; rename it, add people, or leave. |
| **Notifications** | Desktop notifications for DMs, group messages and friend requests while the app is in the background. |
| **End-to-end encryption** | The server only ever sees ciphertext. Every message has its own key. |
| **PIN lock** | A PIN on every launch. It also encrypts everything the app stores on your computer. |
| **Black-out key** | One key (Esc by default) turns the window completely black. Only your PIN brings it back. |
| **Wipe PIN** | A second PIN that erases everything on your computer and leaves the app looking freshly installed. |
| **Themes** | Kali (black and white, the default), Matrix, Amber and Midnight. |

There's no profanity filter: privatewebchat is for a private group of friends, not the public.

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/images/friends-pending.png" alt="Friends page with two incoming friend requests"><br><sub><b>Friend requests.</b> Pending requests wait here with Accept and Decline.</sub></td>
<td width="50%"><img src="docs/images/add-friend.png" alt="Add friend tab with a username box and everyone on the server"><br><sub><b>Add friend.</b> Type a username, or pick someone from the list.</sub></td>
</tr>
<tr>
<td><img src="docs/images/dm.png" alt="A direct message conversation with sam that says messages disappear after 24 hours"><br><sub><b>Direct messages.</b> Only the two of you can read them, and they're gone after 24 hours.</sub></td>
<td><img src="docs/images/profile.png" alt="Profile card for sam with Message, Verify, Remove friend and Block"><br><sub><b>Profiles.</b> Click any name to message, verify, unfriend or block.</sub></td>
</tr>
<tr>
<td><img src="docs/images/unlock.png" alt="PIN lock screen"><br><sub><b>PIN on every launch.</b> Five wrong tries start a growing delay.</sub></td>
<td><img src="docs/images/settings.png" alt="Settings: Appearance, black-out key and wipe PIN"><br><sub><b>Settings.</b> Theme, black-out key, wipe PIN, notifications and PIN.</sub></td>
</tr>
</table>

### The black-out key and the wipe PIN

<img src="docs/images/blackout-flow.svg" width="860" alt="Press Esc and the window goes black. Type your PIN and Enter to come back, or the wipe PIN to erase everything">

- Press your key and the whole window turns black instantly: no text, no cursor, no hint that it's a chat app. Notifications stop while it's black.
- To come back, type your PIN and press **Enter**. Nothing is shown while you type.
- Optionally, the key also works while the app is in the background (Settings → *Also works when privatewebchat is in the background*). Pick a key you don't use elsewhere, like F9.
- Typing the **wipe PIN** instead, here or on the lock screen, erases your identity, every message and all settings. The app then opens like a fresh install.

## Themes

Pick one in **Settings → Appearance**. The default, **Kali**, is black with white text, Kali blue highlights and a Kali-style prompt (`┌──(maya㉿privatewebchat)-[~/general]`) above the message box.

<table>
<tr>
<td width="33%"><img src="docs/images/theme-matrix.png" alt="The Matrix theme: green on black"><br><sub><b>Matrix.</b> Green on black.</sub></td>
<td width="33%"><img src="docs/images/theme-amber.png" alt="The Amber theme: amber on black"><br><sub><b>Amber.</b> Retro amber.</sub></td>
<td width="33%"><img src="docs/images/theme-midnight.png" alt="The Midnight theme: navy and gold"><br><sub><b>Midnight.</b> Navy and gold.</sub></td>
</tr>
</table>

## How it works

<img src="docs/images/how-it-works.svg" width="860" alt="maya's app encrypts, the relay on Render passes along ciphertext, sam's app decrypts">

The **app** is a small C program that opens the system's built-in web view (WKWebView on Mac, WebView2 on Windows) and serves its interface to it from `127.0.0.1`. All the encryption happens in that interface with WebCrypto: **ECDH P-256 → HKDF-SHA-256 → AES-KW** wraps a fresh **AES-256-GCM** key for every message. It's the same scheme as the EduArcade chatboard, but with lasting identities.

The **server** is a Node relay on Render, reached over `wss://` on port 443. It forwards encrypted envelopes and holds them for people who are offline: up to 24 hours for DMs and up to 14 days for everything else. It keeps nothing on disk by default.

### Invite only

<img src="docs/images/invite-chain.svg" width="860" alt="The developer signs one invite code per friend; each friend joins with their code">

Each invite code is a one-time key that you, the developer, sign. Joining signs the new member's identity with it, and the server checks that signature on every connection. Members' apps hand the server what it needs when they connect, so a free Render instance that restarts and forgets everything still knows exactly who's allowed in.

Friend requests, group names and member lists are encrypted messages too, so the server never learns who's friends with whom.

## Running the server (for the developer)

You need a free [Render](https://render.com) account. You only do this once.

**1. Deploy the server.** In Render, choose **New → Blueprint** and pick this repo; `render.yaml` sets everything up. (To set it up by hand instead, create a **Web Service** with build command `cd server && npm ci` and start command `node server/index.js`.) Leave `OWNER_KEY` empty for now. Your address will be something like `your-privatewebchat.onrender.com`.

**2. Create the network.** Open the app and click **Developer? Set up a server** at the bottom of the first screen. Enter your Render address, pick your username and a PIN. The app then shows your **OWNER_KEY**:

<img src="docs/images/owner-key.png" width="720" alt="The app showing the OWNER_KEY to paste into Render">

In Render, open the service, go to **Environment**, add `OWNER_KEY` with that value, and save. Render restarts the server, and the app connects by itself as soon as it's ready.

**3. Invite your friends.** Click **Invite someone**, pick how long the code lasts (1 hour, 24 hours or 7 days) and send it to one person privately. Only you see this button. Each code contains your server's address, so your friends never have to type it.

<img src="docs/images/invite.png" width="720" alt="The invite dialog with an invite code and a Copy button">

**Removing someone:** open their profile and click **Remove from network**. They're disconnected immediately and can't come back without a new code.

## Building from source

| Platform | Command | Output |
|---|---|---|
| Mac | `app/build-mac.sh` (needs `xcode-select --install`) | `app/dist/privatewebchat-mac.zip` (universal: Apple Silicon and Intel) |
| Windows | `app\build-windows.bat` from the *x64 Native Tools Command Prompt* (Visual Studio Build Tools) | `app\dist\privatewebchat.exe` |
| Windows, built on a Mac or Linux | `brew install mingw-w64`, then `app/build-windows.sh` | `app/dist/privatewebchat.exe` |

**GitHub Actions** (`.github/workflows/build.yml`) builds both apps and runs every test on each push to `main`. Pushing a version tag publishes both downloads on the Releases page:

```sh
git tag v1.0.1
git push origin v1.0.1
```

## Tests

```sh
cd server && npm ci && cd ..
node tests/protocol.test.js   # certificates, owner-only invites, removals, encryption
node tests/server.test.js     # the relay end to end: invites, unique usernames, delivery, expiry, restarts
node tests/ui/run.js          # three people use the real interface in headless Chrome (needs Google Chrome and Node 22+)
app/tools/selftest.sh         # Mac: checks WebCrypto, bindings and WebSocket inside the real app window
```

The UI test plays out a whole session: setting up the server, invites (including reusing one, a member trying to invite, and a taken username), General, friend requests, DMs with notifications, DMs deleting themselves after 24 hours, group chats, themes, the black-out key, the lock screen, the wipe PIN and removing a member. It also takes the screenshots in this README.

## Security: what's protected and what isn't

**Protected**
- **Message contents**, plus group names, group members and friendships. These are encrypted on your computer, and the server can't read them.
- **Sender authenticity.** Only the real sender can wrap a key that you can open, so messages can't be forged in someone else's name.
- **Membership.** Only codes signed by the developer work, each one once, and they expire.
- **Data at rest.** One AES-GCM vault, keyed with PBKDF2 (600,000 rounds) over your PIN plus a device secret kept in the Mac Keychain or Windows DPAPI. A copied vault file can't be cracked elsewhere, and wiping deletes the device secret, so even a recovered copy stays unreadable.
- **Key verification.** Safety numbers (*Profile → Verify safety number*) let two people check in person that the server hasn't swapped anyone's keys.

**Visible to the server:** who sends to whom, when, and how big each message is. Also IP addresses (to Render).

**Visible on the computer without the PIN:** only your chosen theme, so the lock screen can use it.

**Things to know**
- Anyone who gets an **unused** invite code can join with it, so send codes privately.
- DMs are deleted after 24 hours by the apps themselves. Someone could still screenshot or copy a message before then.
- If the developer's app is wiped, the network keeps working, but nobody can invite or remove people anymore. Starting over means setting a new `OWNER_KEY` and re-inviting everyone.
- People who join later can't read messages sent before they joined.
- Each identity lives on one computer. A forgotten PIN means asking for a new code.
- Render's free plan sleeps when idle and keeps nothing on disk, so messages waiting for someone offline are lost if it restarts. A paid instance with a disk and `DATA_DIR=/var/data` keeps them.

## Project layout

```
app/
  src/            C: main.c (window, local server for the interface, bindings), platform_mac.c, platform_win.c, embed.c
  ui/             The interface: index.html, style.css (themes), app.js, vault.js (encrypted storage), protocol.js (crypto)
  vendor/webview/ webview library (MIT)
  build-mac.sh, build-windows.bat, build-windows.sh, tools/selftest.sh
server/           Node relay for Render (index.js); shares app/ui/protocol.js
tests/            protocol, server and UI tests
docs/images/      README images
render.yaml       Render blueprint
```

## FAQ

**Why C instead of Electron?** Size. An Electron app is over 100 MB; privatewebchat is about 150 KB on Mac because it uses the web view the OS already has.

**Can I change my username?** No. It's part of your signed membership, which is what lets everyone trust that `sam` is really sam.

**Can members invite their own friends?** No. Only the developer can create invite codes.

**Do I have to be friends to talk?** Not in General. DMs and group chats are for friends only.

**Can I keep a DM longer than 24 hours?** No. That's deliberate, for privacy and to save space. Group chats and General are kept.

**What happens if the server restarts?** Everyone reconnects automatically and the server re-learns the network from members' apps. Only messages still waiting for offline people are lost.

---

<sub>Built on [webview](https://github.com/webview/webview) (MIT). Encryption design adapted from the EduArcade chatboard.</sub>
