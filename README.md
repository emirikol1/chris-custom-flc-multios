# Chris's Custom FLC MultiOS

A desktop join client for [Foundry Virtual Tabletop](https://foundryvtt.com/) on **Windows**, **macOS**, and **Linux**. Built with Electron and Chromium so you can connect to remote Foundry servers from a dedicated app instead of juggling browser tabs.

**Inspired by [Foundry Lightweight Client (FLC)](https://github.com/phenomen/flc)** — the original open-source FLC by [phenomen](https://github.com/phenomen) ([website](https://foundry.ruleplaying.com/flc)). This project is a custom, cross-platform fork with additional features (notably FLC MUD). It is **not** affiliated with the original FLC project, [Foundry Virtual Tabletop](https://foundryvtt.com/), or Foundry Gaming, LLC.

Each install starts with an **empty server list** — no servers are bundled or imported from other FLC installs.

## Features

### Server list & connection

- Add, edit, and delete saved Foundry servers (label, URL, optional notes)
- One-click **Connect** opens a dedicated game window per server
- **Get Users** fetches the user list from the server's join page so you pick your Foundry user from a dropdown (or type a name)
- **Login automatically** (on by default per server): selects your user on the Foundry join screen, fills the password if one is saved, and presses Join. Password is optional — users without one log straight in
- **Incognito** mode: connect in a private, non-persistent browser session
- Re-opening a server focuses the existing game window instead of spawning duplicates
- **Popout windows** work: Foundry popouts (`window.open`, PopOut! module) open as real child windows sharing the game session

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
- **Mud Setup** panel appears when Mud is on: pick a provider, press **Test Server** to fill the model dropdown, choose a model, **Save**. Hosted presets link to their free key sign-up page
- If Mud is on but no AI server is set up yet, the app tells you what it needs (a local LM Studio/Ollama with a model loaded, or a hosted key)
- API keys are stored only in the app's local data folder (`ai-provider.json`, user-readable only) and never in the repo or installers

### Other

- Remembers size and position of the join window, game windows, the MUD window, and popouts (off-screen positions are ignored)
- Local log files for troubleshooting (no browsing data, URLs, page content, or credentials logged)
- Small installers: English-only Chromium locale, maximum compression, spellcheck disabled (AppImage ~90 MB, .deb ~90 MB)
- Cross-platform installers built by GitHub Actions

## Install

You do **not** need Git or Node.js to run the app. Pick **one** installer for your operating system.

### Option A — GitHub Releases (recommended)

1. Open **[Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases/latest)**.
2. Download the file for your OS (see table below).
3. Run or open it to install.

| OS | Download | Install |
|----|----------|---------|
| **Windows** | `ChrisCustomFLC-MultiOS-*-windows-setup.exe` | Double-click the installer, follow the prompts |
| **macOS** | `ChrisCustomFLC-MultiOS-*-mac.dmg` | Open the DMG, drag the app to **Applications** |
| **Linux (Mint / Ubuntu / Debian)** | `ChrisCustomFLC-MultiOS-*-linux.deb` | Double-click the `.deb`, or `sudo apt install ./file.deb` |
| **Linux (other)** | `ChrisCustomFLC-MultiOS-*-linux.AppImage` | Right-click → **Properties** → allow executing, then double-click |

### Option B — Installers in this repository (`dist/`)

Pre-built installers are also committed under [`dist/`](dist/) (large binaries use [Git LFS](https://git-lfs.github.com/)).

If you cloned the repo, fetch LFS objects first:

```bash
git lfs pull
```

Then install the file that matches your OS:

| OS | File in `dist/` | Install |
|----|-----------------|---------|
| **Linux (.deb)** | `ChrisCustomFLC-MultiOS-0.2.1-linux.deb` | Double-click or `sudo apt install ./dist/ChrisCustomFLC-MultiOS-0.2.1-linux.deb` |
| **Linux (AppImage)** | `ChrisCustomFLC-MultiOS-0.2.1-linux.AppImage` | Mark executable (`chmod +x`), then run |
| **Windows** | `ChrisCustomFLC-MultiOS-*-windows-setup.exe` | Available from [Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases/latest) when built |
| **macOS** | `ChrisCustomFLC-MultiOS-*-mac.dmg` | Available from [Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases/latest) when built |

> **Note:** The `dist/` folder currently ships Linux builds in-tree. Windows and macOS installers are produced by CI and attached to GitHub Releases.

## First run

1. Launch **Chris's Custom FLC MultiOS**.
2. Add a server: enter the URL, press **Get Users**, pick your Foundry user (password only if your user has one), leave **Login automatically** checked.
3. Click **Connect** — you land in the game logged in.
4. To use **FLC MUD**, tick **Mud** in the toolbar, complete **Mud Setup** (provider → **Test Server** → model → **Save**), then connect to a game so chat can be captured.

Saved data (servers, GPU prefs, MUD settings, logs) lives in the app's user data directory — not in the install folder.

## Develop from source

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

Output goes to `dist/`. The `predist` step refuses to package if dev `data/servers.json` or log files are present.

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
