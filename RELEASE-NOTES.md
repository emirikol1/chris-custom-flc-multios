# v0.2.0

Chris's Custom FLC MultiOS — Foundry VTT join client for Windows, macOS, and Linux.

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
