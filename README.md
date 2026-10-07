# Chris's Custom FLC MultiOS

This is a program you install on your computer to join a [Foundry Virtual Tabletop](https://foundryvtt.com/) game. It runs on **Windows**, **Mac**, and **Linux**. You do not need Git, Node, or a browser tab.

It is **not** the official Foundry app, and it is **not** the original [Foundry Lightweight Client](https://github.com/phenomen/flc). Your install starts with an empty game list. Nothing is copied in from another copy of FLC.

## Get the app

**[Download the latest version](https://github.com/emirikol1/chris-custom-flc-multios/releases/latest)**

That page lists one file for each kind of computer. Download the one in this table, then install it the way the last column says.

| Your computer | File to download | Then do this |
|---------------|------------------|--------------|
| **Windows** | The file whose name ends with `windows-setup.exe` | Double-click it and follow the prompts |
| **Mac** | The file whose name ends with `.dmg` | Open it and drag the app to **Applications** |
| **Linux Mint, Ubuntu, or Debian** | The file whose name ends with `.deb` | Double-click it |
| **Other Linux** | The file whose name ends with `.AppImage` | Right-click it, open **Properties**, allow executing, then double-click it |

The app in your menu or Applications folder is named **Chris's Custom FLC MultiOS**. Installing a newer copy updates that same icon. It does not add a second one.

**Windows or a Mac may refuse to open it the first time.** That is normal. The installers are not signed with an Apple or Microsoft developer certificate, so the computer asks you to approve this one app. Leave your security software on. The buttons move between versions of Windows and macOS, so if you cannot find the button, use **[If Windows or Mac blocks the app](#if-windows-or-mac-blocks-the-app)**. Linux does not need that extra approval.

When the app is open, **[add your game](#first-run)**.

## Features

### Server list & connection

- **Add Server** opens a separate server-configuration window (label, URL, notes, user, password, auto-login); **Edit**, **Clone** (pre-filled copy), and **Delete** per server keep the main panel uncluttered
- One-click **Connect** opens a dedicated game window per server
- **Get Users** fetches the user list from the server's join page so you pick your Foundry user from a dropdown (or type a name)
- **Login automatically** (on by default per server): selects your user on the Foundry join screen, fills the password if one is saved, and presses Join. Password is optional — users without one log straight in
- **Incognito** mode: connect in a private, non-persistent browser session
- Re-opening a server focuses the existing game window instead of spawning duplicates
- **Popout windows** work: Foundry popouts (`window.open`, PopOut! module) open as real child windows sharing the game session
- **Your servers** panel collapses to a compact list (server + session username + Connect)
- **Screen state per session:** when you leave a server (close, disconnect, reload, or quit) the app records which Foundry windows and PopOut! popouts were open, with their size and position; the next time you connect to that server it reopens them and closes anything that wasn't part of the layout. Windows whose document no longer exists are skipped (and forgotten) without affecting the rest. Nothing is restored if your desktop/monitor layout changed since
- **Forget layout** button per server (expanded list) clears that session's remembered layout and prompt appearance if a bad one is blocking your connection
- **Prompt windows always on main window** (game window View menu, on by default): short-lived prompts open centered in the game window. Sheets, journals, and the combat tracker stay put
- **Highlight Prompts** (View submenu): glow color, glow strength (0–300%, default 100%), and **Auto-Raise**. Saved on that server profile when you change them; Clone copies them; Forget layout returns them to the defaults
- **Bring All FLC Windows to Front** (game window **View → Diagnostics**, and **View** on every other window; Ctrl+Shift+U or Cmd+Shift+U): restores minimized FLC windows and raises every FLC window, leaving the window you ran the command from in front
- A prompt raises the window it opened in, or flashes the usual operating-system attention when Auto-Raise is off. The game window also raises itself shortly after it opens and does not stay pinned on top

### Rendering & compatibility

- Chromium-based game view (same engine family as Chrome)
- **WebGL** status indicator with **Auto / Force hardware / Force software** override
- Automatic fallback to software WebGL (SwiftShader) when hardware rendering fails, with app relaunch to apply

### FLC MUD (AI play-by-play)

- **Off by default.** Turn it on with the **Mud** checkbox in the toolbar (left of Incognito); the setting is remembered
- Optional **Mud** window that narrates Foundry chat as 1990s ROM/Diku-style MUD text
- Captures Foundry chat, rolls, emotes, whispers, and token movement from the game window
- **Table companion** panel: ask questions about the live log or narration
- Optional **Post MUD to Foundry chat** (off by default)
- **Speak as** OOC, selected token (IC), or a custom alias (when Foundry allows)
- Running **combat scoreboard** (damage dealt/taken, heals, crits, natural 1s) with `/reset`
- ROM color codes and damage-verb ladder rendered in the MUD log; copy preserves ANSI codes

### AI provider setup (for FLC MUD)

- **Local (free):** LM Studio, Ollama
- **Hosted free tier:** Groq, Cerebras, Google Gemini (AI Studio), OpenRouter (free models), Mistral (Experiment)
- **Paid:** OpenAI
- **Custom:** any OpenAI-compatible `/v1` API URL
- **Mud Setup** panel (below your servers) appears when Mud is on: pick a provider, press **Test Server** to fill the model dropdown, choose a model, **Save**. Hosted presets link to their free key sign-up page
- Collapses to the provider name plus a **red/green light** showing whether the AI server is reachable and the saved model is loaded (checked on start, after Save, every minute, or by clicking the light)
- Works with "thinking" models (Qwen3, DeepSeek-R1): `<think>` reasoning is stripped from the MUD text
- If Mud is on but no AI server is set up yet, the app tells you what it needs (a local LM Studio/Ollama with a model loaded, or a hosted key)
- API keys are stored only in the app's local data folder (`ai-provider.json`, user-readable only) and never in the repo or installers

### Other

- Remembers size and position of every app window. The join window and server-configuration window are global; the game window, its popouts, and the MUD window are remembered **per saved server**, so every session can have its own layout (off-screen positions are ignored)
- **Import / Export** (header buttons): one JSON file with servers (including usernames/passwords), Mud Setup (including API key), Mud options, preferences, and window layouts. Import merges servers by id or URL. The file is written owner-only; keep it private
- **Check for updates** (header button): looks for a newer installer only when you press it. If one is available, the button becomes **Download update**. That saves the installer in your Downloads folder and leaves the install instructions on screen until you close the app. Close the app, then run that file yourself
- Local log files for troubleshooting (no browsing data, URLs, page content, or credentials logged)
- Small installers: English-only Chromium locale, maximum compression, spellcheck disabled (AppImage ~90 MB, .deb ~90 MB)
- Cross-platform installers built by GitHub Actions

### Diagnostics

The game window's **View → Diagnostics** menu opens World Statistics, the logs folder, and the problem log. The problem log is `problem-log.jsonl` in the app data folder, one JSON line per issue. A line records when a warning or error started, when it ended (`resolved`, `closed`, or `quit`; a crash or an unresponsive page is an `event` written as soon as it happens), how long it lasted, the profile name when that name is safe to store, a short server id (`srv:` plus six hex characters), the issue id, category, severity, title, a short evidence string, and the client, Foundry, and game-system versions. It does not contain addresses, page content, document names, or account names. When the file grows past about 1 MB, the previous copy is kept as `problem-log.1.jsonl`. **Open problem log** on that menu opens the file.

## If Windows or Mac blocks the app

The download is at the [top of this page](#get-the-app). You do **not** need Git or Node.js.

Windows and Mac stop this app the first time you open it. The installers are not signed with an Apple or Microsoft developer certificate, so the computer treats the publisher as unknown and asks you to approve the app once. That approval is required before the app will open. Leave Windows Security and Mac security turned on. You are allowing this one app.

Find the message on your screen, then do the step beside it.

| OS | What you see | What to do |
|----|----------------|------------|
| **Windows** | Windows protected your PC | Click **More info**, then **Run anyway**. If that button is missing, right-click the installer, open **Properties**, check **Unblock**, and run it again. |
| **Mac** | The app cannot be opened because the developer cannot be verified | Drag the app to **Applications**. Control-click it and choose **Open**, then click **Open** again. If **Open** is missing, open **System Settings → Privacy & Security** (older Macs: **System Preferences → Security & Privacy**) and click **Open Anyway**. |
| **Mac** | The app is damaged and can't be opened | Use the Mac Terminal commands below. |
| **Linux** | The installer opens normally | No extra approval. Double-click the downloaded file. If that does nothing, open it with your software installer. |

Those on-screen buttons move between versions of Windows and macOS. When you cannot find the button, paste the commands below. On Windows, close this app first, then paste in PowerShell from your Downloads folder. On a Mac, drag the app to Applications first, then paste in Terminal.

**Windows**

```powershell
Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Unblock-File
Start-Process (Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
```

**Mac, after the app is in Applications**

```bash
xattr -dr com.apple.quarantine "/Applications/Chris's Custom FLC MultiOS.app"
open "/Applications/Chris's Custom FLC MultiOS.app"
```

**Mac, when it says the app is damaged**

```bash
codesign --force --deep --sign - "/Applications/Chris's Custom FLC MultiOS.app"
xattr -dr com.apple.quarantine "/Applications/Chris's Custom FLC MultiOS.app"
open "/Applications/Chris's Custom FLC MultiOS.app"
```

Older copies of the app are on **[Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases)**. Use the latest one from the [top of this page](#get-the-app) unless you need an older copy.

## First run

1. Launch **Chris's Custom FLC MultiOS**.
2. Add a server: enter the URL, press **Get Users**, pick your Foundry user (password only if your user has one), leave **Login automatically** checked.
3. Click **Connect** — you land in the game logged in.
4. To use **FLC MUD**, tick **Mud** in the toolbar, complete **Mud Setup** (provider → **Test Server** → model → **Save**), then connect to a game so chat can be captured.

Saved data (servers, GPU prefs, MUD settings, logs) lives in the app's user data directory — not in the install folder.

## More detail

### Loading banner

While a world is joining, the loading card shows a short bundled clip just above the fuel gauges. The banner is as wide as the card and keeps the clip's shape, so it scales with the window. It is stored with the app, so the join does not wait on a download, and nothing is added until that card is already on screen.

When this server has a usual join time, the clip stays paused until about one clip length remains (at most a second early), then speeds up or slows down (between half speed and double speed) so it ends as the game appears. The first join has no estimate, so it stays paused through world setup and starts when the scene is drawn.

The banner drops out, with no empty gap, when the card is under about 520 pixels wide or the window is under about 560 pixels tall, so the gauges and progress bar still fit. It stays off when the system asks for reduced motion, and it is removed when the loading card closes. The Loading banner is default on. The Join window **Loading banner** checkbox turns it off.

The loading banner randomly plays one of two packaged clips, and the connecting and loading screens stay black.

### Slow server detection

Some Foundry servers sit behind a reverse proxy that marks package files — scripts, style sheets, fonts, and the same kind of file under the system and module folders — with `Cache-Control: no-cache`, and only speaks HTTP/1.1. Every join then spends about 15–20 seconds re-checking those unchanged files before the loading screen can appear. The game window stays black while that happens.

This client cannot change that safely. When it sees the pattern (dozens of those files, almost all marked no-cache), it remembers a yes/no flag for that saved server. The flag is the server's short id, a couple of counts, and whether you dismissed the note. No address is stored.

The note is shown only when the responses are nginx and the no-cache pattern matches the fix in the message. Worlds on forge-vtt.com are skipped, because that host is not a server the player can reconfigure.

- During the black screen, a card explains the wait and lets you copy a message for the server admin
- On that server's card in the Join window, an amber **Server config could be optimized — Copy message for admin** button

The message tells an nginx admin how to turn on HTTP/2 and let browsers reuse those files while still picking up updates in the background. **Don't show again for this server** hides the note for that server only.

### Develop from source

Requirements: **Node.js 22+** and **npm**.

```bash
git clone https://github.com/emirikol1/chris-custom-flc-multios.git
cd chris-custom-flc-multios
npm install
npm start
```

Run tests:

```bash
npm test
```

Build installers locally:

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS DMG
```

Output goes to `dist/` on that machine. Published installers are the GitHub Release files. The `predist` step refuses to package if dev `data/servers.json` or log files are present.

## Credits & attribution

| Project | URL |
|---------|-----|
| **Foundry Lightweight Client (FLC)** — original inspiration | https://github.com/phenomen/flc |
| FLC website | https://foundry.ruleplaying.com/flc |
| **This project** | https://github.com/emirikol1/chris-custom-flc-multios |

The original [Foundry Lightweight Client](https://github.com/phenomen/flc) is an unofficial MIT-licensed app for managing and joining Foundry VTT servers. Chris's Custom FLC MultiOS reimplements and extends that idea for Windows, macOS, and Linux using Electron/Chromium, with optional AI play-by-play (FLC MUD) and other custom features.

## License & disclaimer

This project is not affiliated with, endorsed by, or supported by:

- [phenomen/flc](https://github.com/phenomen/flc) (Foundry Lightweight Client)
- [Foundry Virtual Tabletop](https://foundryvtt.com/) or Foundry Gaming, LLC

See repository history and release tags for this project's licensing. Do not ask Foundry staff or the original FLC maintainer for support for this fork — use [this repo's issues](https://github.com/emirikol1/chris-custom-flc-multios/issues) instead.
