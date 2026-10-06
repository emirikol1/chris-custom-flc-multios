# Installers (`dist/`)

End users can install from here **without cloning the full repo** — download only the file for your OS, or clone and run `git lfs pull` first (binaries are stored with Git LFS).

Full instructions and feature list: **[project README](../README.md)**.

Inspired by the original [Foundry Lightweight Client](https://github.com/phenomen/flc) (`https://github.com/phenomen/flc`).

## Files in this folder

| File | Platform | Install |
|------|----------|---------|
| `ChrisCustomFLC-MultiOS-0.4.1-linux.deb` | Linux (Debian/Ubuntu/Mint) | Double-click, or `sudo apt install ./ChrisCustomFLC-MultiOS-0.4.1-linux.deb` |
| `ChrisCustomFLC-MultiOS-0.4.1-linux.AppImage` | Linux (portable) | `chmod +x ChrisCustomFLC-MultiOS-0.4.1-linux.AppImage` then run |

Windows (`.exe`), macOS (`.dmg`), and current Linux builds are attached to **[GitHub Releases](https://github.com/emirikol1/chris-custom-flc-multios/releases/latest)** when CI publishes them. The files in this folder are the last Linux installers committed here.

Windows and macOS installers are unsigned. Approve them once; the on-screen control moves, and these commands do not.

Windows, in PowerShell from the download folder:

```powershell
Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Unblock-File
Start-Process (Get-ChildItem .\ChrisCustomFLC-MultiOS-*-windows-setup.exe | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
```

macOS, in Terminal after dragging the app to Applications:

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
