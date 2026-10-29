<div align="center">

<img src="app/icons/icon.png" width="120" alt="privatewebchat app icon: a terminal prompt">

# privatewebchat

**Private, invite-only chat for you and your friends, on Mac (Apple Silicon) and Windows.**

<img src="https://img.shields.io/badge/macOS-12%2B%20Apple%20Silicon-1c1c1c?style=for-the-badge&labelColor=0e0e0e&logo=apple&logoColor=white" alt="macOS">
<img src="https://img.shields.io/badge/Windows-10%20%7C%2011-1c1c1c?style=for-the-badge&labelColor=0e0e0e&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0zIDNoOC41djguNUgzek0xMi41IDNIMjF2OC41aC04LjV6TTMgMTIuNWg4LjVWMjFIM3pNMTIuNSAxMi41SDIxVjIxaC04LjV6Ii8%2BPC9zdmc%2B" alt="Windows">
<img src="https://img.shields.io/github/v/release/gronkreeks/privatewebchat?style=for-the-badge&labelColor=0e0e0e&color=367bf0&label=release&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMSAzaDJ2MTAuNmwzLjMtMy4zIDEuNCAxLjRMMTIgMTcuNGwtNS43LTUuNyAxLjQtMS40IDMuMyAzLjN6TTUgMTloMTR2Mkg1eiIvPjwvc3ZnPg%3D%3D" alt="Latest release">
<img src="https://img.shields.io/badge/encryption-end--to--end-367bf0?style=for-the-badge&labelColor=0e0e0e&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik03IDEwVjdhNSA1IDAgMCAxIDEwIDB2M2gxYTEgMSAwIDAgMSAxIDF2MTBhMSAxIDAgMCAxLTEgMUg2YTEgMSAwIDAgMS0xLTFWMTFhMSAxIDAgMCAxIDEtMXptMiAwaDZWN2EzIDMgMCAwIDAtNiAweiIvPjwvc3ZnPg%3D%3D" alt="End-to-end encrypted">

<br>

<img src="docs/images/chat.png" width="860" alt="A group chat in privatewebchat: black background, white text, a Kali-style prompt above the message box">

</div>

## What it is

A small desktop chat app for a closed group of friends. You can't sign up: you need an invite code to get in. Once you're in, there's:

- **General**, a chat for everyone
- **Friends**, added by username
- **Direct messages** with friends, deleted automatically after 24 hours
- **Group chats** with any of your friends
- **Desktop notifications** for DMs, groups and friend requests, even with the window closed: privatewebchat keeps running in the system tray (Windows) or the menu bar and Dock (Mac) until you choose Quit
- **A PIN lock** every time you open the app
- **A black-out key** that instantly turns the window black, until you type your PIN
- **A wipe PIN** that erases everything on your computer
- **Messages that only last while the server is running**: if the server goes offline, every message is deleted from everyone's computer

## Getting in

1. Download the app from [**Releases**](../../releases/latest):

   | | Download |
   |---|---|
   | **Windows 10 / 11** | [`privatewebchat.exe`](../../releases/latest/download/privatewebchat.exe) |
   | **Mac (Apple Silicon, macOS 12+)** | [`privatewebchat.dmg`](../../releases/latest/download/privatewebchat.dmg) |

   Intel Macs aren't supported.
2. Open it. On Mac, open the .dmg and drag privatewebchat into Applications. The first time, your computer will warn that the app isn't from an identified developer:
   - **Mac:** right-click the app → **Open** → **Open**. If there's no Open button, go to **System Settings → Privacy & Security** and click **Open Anyway**
   - **Windows:** **More info** → **Run anyway**
3. Paste your invite code, then pick a username and a PIN.

### Checking your download

Every release lists a `SHA256SUMS.txt` with a checksum for each file. If your file's checksum matches, it's exactly the file that was published:

- **Windows** (PowerShell): `Get-FileHash privatewebchat.exe`
- **Mac** (Terminal): `shasum -a 256 privatewebchat.dmg`

The app is built from the code in this repository: `app/build-windows.sh` and `app/build-mac.sh`.

## End-to-end encryption

Every message is encrypted on your computer before it's sent, and only the people it's meant for can decrypt it. The server just passes along scrambled data. It can see that a message went from one person to another, but not what it says, what your groups are called, or who's on your friends list.

Each message gets its own key, so no single message key unlocks a whole conversation. Everything the app saves on your computer is also encrypted with your PIN, and erased for good if you use the wipe PIN.

## Messages disappear when the server goes offline

Messages only last as long as the server keeps running. The server never stores them to begin with, and if it goes offline (a restart, an update, or the free hosting going to sleep after a quiet spell), every app deletes all its messages the next time it connects. That includes messages that hadn't been delivered yet. Your friends, groups and username are kept. A chat that never outlives the server can't be dug up later.

## Themes

Change the look in **Settings → Appearance**. The default is **Kali**: black, white and Kali blue. **Kali Light** is the same on white.

<table>
<tr>
<td width="33%"><img src="docs/images/theme-matrix.png" alt="The Matrix theme: green on black"><br><sub><b>Matrix</b></sub></td>
<td width="33%"><img src="docs/images/theme-amber.png" alt="The Amber theme: amber on black"><br><sub><b>Amber</b></sub></td>
<td width="33%"><img src="docs/images/theme-midnight.png" alt="The Midnight theme: navy and gold"><br><sub><b>Midnight</b></sub></td>
</tr>
</table>

## FAQ

**How do I get an invite code?** Ask the developer. Each code works for one person.

**Can I change my username?** No. Usernames are permanent, so everyone knows who they're talking to.

**Do I have to be friends with someone to talk to them?** Not in General. DMs and group chats are for friends only.

**Can I keep a DM longer than 24 hours?** No. That's on purpose, for privacy. General and group chats are kept until the server goes offline.

**Why did all my messages disappear?** The server went offline, so every message was deleted. That's on purpose too (see above).

**How do I quit?** Closing the window keeps privatewebchat running so notifications still arrive. When you come back, it asks for your PIN. To quit for real, use the tray icon's menu on Windows, or **Quit** in the menu bar icon or Cmd+Q on Mac.

**What if I forget my PIN?** It can't be reset, because it's what encrypts your data. Ask the developer for a new invite code.

**Why is the Mac download so much bigger?** The Mac app has Chromium built in (the engine behind Google Chrome), so it runs the same way on every Mac. On Windows the app uses Microsoft's WebView2, which is also Chromium and is already part of Windows, so the .exe stays small.
