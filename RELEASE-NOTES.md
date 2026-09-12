# v0.4.0

Chris's Custom FLC MultiOS — Foundry VTT join client for Windows, macOS, and Linux.

## What's new in 0.4.0

- **Screen state saved per session.** On close, disconnect, reload, or quit the app records the open Foundry windows (sheets, sidebar tabs, module apps) and PopOut! popouts with their sizes and positions. Reconnecting to that server reopens them and force-closes windows that weren't part of the layout, so you come back to the same screen. Windows whose document is gone are skipped and forgotten without affecting anything else; if your desktop/monitor layout changed, nothing is restored.
- **Forget layout** button per server in the expanded list, for when a bad layout blocks a connection.
- **MUD window position is per session** (join window and server-configuration window stay global).
- **Server configuration window.** *Add Server*, *Edit*, and the new **Clone** open a dedicated window instead of a form in the main panel.

## What's new in 0.3.0

- **Import / Export settings** as JSON: servers (with credentials), Mud Setup (with API key), Mud options, preferences, and window layouts. Import merges servers by id or URL.
- **Per-session window layouts:** each saved server remembers its own game-window size/position and each of its popouts' size/position (popout 1, popout 2, …). New servers start from your last game layout.
- **Collapsible panels:** *Your servers* collapses to server + session username + Connect; *Mud Setup* (now below the server list) collapses to the provider name and a red/green connectivity light. Collapsed state is remembered.

## Fixes in 0.2.1

- **PopOut! module works.** The game window now identifies as plain Chrome, so PopOut! no longer shows "cannot work within the standalone FVTT Application".
- **Clean MUD text with thinking models.** `<think>…</think>` reasoning from models like Qwen3 / DeepSeek-R1 is stripped before display, storage, and `SILENCE` detection; previously saved history is cleaned on load.

## What's new in 0.2.0

- **FLC MUD is off by default.** New **Mud** checkbox in the toolbar (left of Incognito) turns it on; remembered between runs.
- **Mud Setup** panel with **Test Server**: choose LM Studio, Ollama, Groq, Cerebras, Gemini, OpenRouter (free models), Mistral, OpenAI, or a custom URL; test fills the model dropdown; keys stay on your machine.
- **Get Users** button fetches the user list from your Foundry server so the username is a dropdown.
- **Login automatically** (per server, default on): selects your user, fills the password if saved, and presses Join. Password is optional.
- **Popout windows** now open (Foundry popouts / PopOut! module).
- **Window memory:** join, game, MUD, and popout windows reopen at their last size and position.
- **Smaller installers:** English-only locale and maximum compression (Linux AppImage 128 MB → 90 MB, .deb 99 MB → 90 MB); spellcheck disabled in all windows.

Inspired by [Foundry Lightweight Client (FLC)](https://github.com/phenomen/flc). Not affiliated with the original FLC project or Foundry Gaming, LLC.

## Install

Download **one** file for your computer. No Git or Node.js required.

| OS | File | What to do |
|----|------|------------|
| Windows | `ChrisCustomFLC-MultiOS-*-windows-setup.exe` | Double-click, then follow the installer |
| macOS | `ChrisCustomFLC-MultiOS-*-mac.dmg` | Double-click, drag the app to Applications |
| Linux (Mint/Ubuntu/Debian) | `*.deb` | Double-click the downloaded file |
| Linux (AppImage) | `*.AppImage` | Allow executing, then double-click |

Each install starts with an empty server list.

## Highlights

- Saved server list with Get Users dropdown and optional automatic login (password optional)
- Incognito sessions and WebGL hardware/software controls with automatic fallback
- FLC MUD: AI play-by-play narration of Foundry chat (ROM/Diku style), table companion Q&A, optional post-back to Foundry chat, combat scoreboard
- AI providers: LM Studio, Ollama, Groq, Cerebras, Gemini, OpenRouter, Mistral, OpenAI, or custom OpenAI-compatible APIs

See the [README](README.md) for the full feature list and development setup.
