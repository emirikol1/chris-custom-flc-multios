# Chris's Custom FLC MultiOS

Join **Foundry VTT** games from a desktop app. Each install starts with an empty server list — you add your own.

## Download and install

Open **[Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases)** → download **one** file for your system → install it.

| You use | Download | Then |
|---------|----------|------|
| Linux Mint / Ubuntu / Debian | `chris-custom-flc-multios_*_amd64.deb` | Double-click the file (or `sudo dpkg -i` that file) |
| Other Linux | `*.AppImage` | Make it executable, then double-click |
| Windows | `*Setup*.exe` | Double-click, next, next |
| macOS | `*.dmg` | Open, drag to Applications |

Windows and macOS files appear on Releases when those builds are published. Linux `.deb` and AppImage are on **[v0.1.0](https://github.com/emirikol1/chris-custom-flc-multios/releases/tag/v0.1.0)**.

You do **not** need Git, Git LFS, or Node.js.

---

Passwords you save in the app are stored as plain text on that computer only.

Developers: `npm install && npm start`. Packaged installers: `npm run dist:linux` (and `dist:win` / `dist:mac` on those OSes).
