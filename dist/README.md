# Installer files (`dist/`)

| File | OS | Built on this machine |
|------|-----|------------------------|
| `Chris's Custom FLC MultiOS-0.1.0.AppImage` | Linux | Yes |
| `chris-custom-flc-multios_0.1.0_amd64.deb` | Linux (Debian/Mint/Ubuntu) | Yes |
| `*Setup*.exe` (NSIS) | Windows | No — GitHub Actions `windows-latest` (`npm run dist:win`) |
| `*.dmg` | macOS | No — GitHub Actions `macos-latest` (`npm run dist:mac`) |

Cross-compiling Windows/macOS from this Linux host timed out downloading Electron’s Windows toolchain. After Actions finishes, copy the `.exe` and `.dmg` into this folder and `git add` them (Git LFS).

Do not put `servers.json` here.
