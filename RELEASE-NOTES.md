# v0.5.2

Chris's Custom FLC MultiOS — Foundry VTT join client for Windows, macOS, and Linux.

## What's new in 0.5.2

- No feature changes. This release exists so an installed 0.5.1 can download it with **Check for updates**.

## What's new in 0.5.1

- **Check for updates** on the join window. It runs only when you press it. A newer installer is saved in your Downloads folder. Close the app, then run that file yourself.

## What's new in 0.5.0

- **Prompt windows always on main window.** On the game window's View menu, on unless you turn it off. Short-lived prompts (roll confirmations and other dialogs) open centered in that game window. Character sheets, journals, sidebar tabs, and the combat tracker are left where they are. Drag a prompt by its title bar to keep that one where you put it; the next prompt centers again.
- **Highlight Prompts.** Its own View submenu, on by default. Short-lived prompts get a slow outline glow. Colors: blue (default), red, orange, yellow, green, purple, pink, and white. Each color has a light-desktop and a dark-desktop variant. High-contrast mode keeps a plain outline and turns the glow off.
- **Auto-Raise.** On by default, listed above the colors. The window that actually contains the prompt comes to the front, including a popped-out sheet, and then behaves like a normal window. When Auto-Raise is off, a prompt uses the usual operating-system attention flash, and that flash stops when the window is focused.
- **Glow strength.** Listed under the colors as a percent of the standard glow. Default 100%. Enter a whole number from 0 to 300. Zero removes the halo and leaves the outline.
- Those choices are saved on the server profile when you change them. **Clone** copies them, so two saved connections to the same world can look different. **Forget layout** clears them back to the defaults along with that session's screen layout.
- **Popped-out windows are remembered.** The next connection restores sheets that were popped out, not only their size and position.
- The game window raises itself about two seconds after it opens, including if it was minimized, and does not stay pinned above other windows.
- Logging out of Foundry on purpose does not sign you straight back in.

## Fixes in 0.5.0

- The main game window keeps the place it was opened in when a popped-out sheet is on screen.

## Fixes in 0.4.1

- **Popout window larger than its contents.** PopOut! popouts were not being recognised (the module is a lexical global, not a `window` property), so a new popout inherited the remembered size of a *different* earlier popout and the sheet inside no longer filled the window. Popouts are now identified by the app they hold, remembered sizes are applied only for that same app, and the popped-out app is kept filling its window even if a re-render tries to pin it to pixel sizes.
- Popouts are now correctly recorded and restored as popouts in the per-session screen state.
- The session layout restore no longer runs twice on one page load.

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

Windows and macOS builds are not signed with a developer certificate. Approve the app once. The button in the graphical prompts moves between OS versions; the commands do not.

**Windows.** If the installer is blocked, click **More info**, then **Run anyway**. Or right-click the file → **Properties** → **Unblock**. From PowerShell in your Downloads folder:

```powershell
Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Unblock-File
Start-Process (Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
```

**macOS.** Drag the app to **Applications**, then Control-click it and choose **Open**. If that item is gone, use **System Settings → Privacy & Security → Open Anyway**. From Terminal, after the app is in Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Chris's Custom FLC MultiOS.app"
open "/Applications/Chris's Custom FLC MultiOS.app"
```

If macOS says the app is damaged:

```bash
codesign --force --deep --sign - "/Applications/Chris's Custom FLC MultiOS.app"
xattr -dr com.apple.quarantine "/Applications/Chris's Custom FLC MultiOS.app"
open "/Applications/Chris's Custom FLC MultiOS.app"
```

Each install starts with an empty server list.

## Highlights

- Saved server list with Get Users dropdown and optional automatic login (password optional)
- Incognito sessions and WebGL hardware/software controls with automatic fallback
- FLC MUD: AI play-by-play narration of Foundry chat (ROM/Diku style), table companion Q&A, optional post-back to Foundry chat, combat scoreboard
- AI providers: LM Studio, Ollama, Groq, Cerebras, Gemini, OpenRouter, Mistral, OpenAI, or custom OpenAI-compatible APIs

See the [README](README.md) for the full feature list and development setup.
