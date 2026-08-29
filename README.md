# Chris's Custom FLC MultiOS

Chromium (Electron) client for joining **Foundry VTT** servers. This is a **separate** product from the Linux-only **Chris' Custom FLC** on the original author's desktop. Each installation creates **its own empty** `servers.json`. This repo never includes anyone's personal server list or passwords.

## Requirements to clone this repo

Install [Git LFS](https://git-lfs.com/) **before** cloning (or run `git lfs install` then `git lfs pull`), or the files under `dist/` will be tiny pointer files instead of real installers.

```bash
git lfs install
git clone https://github.com/emirikol1/chris-custom-flc-multios.git
cd chris-custom-flc-multios
git lfs pull
```

Do **not** use GitHub’s “Download ZIP” for the installers — zip archives only contain tiny LFS pointer files, not the real AppImage/`.deb`. Clone with Git LFS as above.

After `git lfs pull`, `dist/*.AppImage` and `dist/*.deb` should be ~100 MB each, not ~130-byte text files.

## Install (end users)

Use the matching file in `dist/` after a full clone + LFS pull. You do **not** need Node.js to run a packaged build.

### Linux — AppImage (no root)

1. Make the AppImage executable:  
   `chmod +x dist/*.AppImage`
2. Run it:  
   `./dist/*.AppImage`  
   (or double-click in the file manager)
3. If the desktop says FUSE is missing, install `libfuse2` (Debian/Ubuntu/Mint) or use the `.deb` instead.

First launch shows an **empty** server list. Add your own servers in the UI.

**Data on this machine:**  
`~/.config/chris-custom-flc-multios/data/servers.json`  
**Logs:**  
`~/.config/chris-custom-flc-multios/logs/`

### Linux — Debian/Ubuntu/Mint (`.deb`)

```bash
sudo dpkg -i dist/*.deb
sudo apt-get install -f   # only if dpkg reports missing dependencies
```

Then open **Chris's Custom FLC MultiOS** from the applications menu.

Same userData paths as the AppImage (per user, not inside the `.deb`).

Uninstall: `sudo apt-get remove chris-custom-flc-multios` (package name may match the electron-builder output; check with `dpkg -l | grep flc`).

### Windows

1. Run `dist/*Setup*.exe` (NSIS installer).
2. Finish the wizard (you can change the install folder).
3. Start **Chris's Custom FLC MultiOS** from the Start Menu or desktop shortcut.

**Data:** `%APPDATA%\chris-custom-flc-multios\data\servers.json`  
**Logs:** `%APPDATA%\chris-custom-flc-multios\logs\`

Windows may warn about an unsigned installer (SmartScreen). For a private group, choose **More info → Run anyway**.

### macOS

1. Open `dist/*.dmg`.
2. Drag the app into **Applications**.
3. Launch **Chris's Custom FLC MultiOS**.

If Gatekeeper blocks an unsigned build: **System Settings → Privacy & Security** → Open Anyway, or right-click the app → **Open**.

**Data:** `~/Library/Application Support/chris-custom-flc-multios/data/servers.json`  
**Logs:** `~/Library/Application Support/chris-custom-flc-multios/logs/`

A `.dmg` is produced on **macOS** (GitHub Actions `macos-latest`, or a Mac). Building a Mac app from Linux is not supported by Electron.

**Windows `.exe` / macOS `.dmg` in this clone:** if they are missing from `dist/`, run the **Build installers** GitHub Actions workflow (`.github/workflows/build-installers.yml`), download the artifacts, copy them into `dist/`, then `git lfs track` + commit. Linux AppImage and `.deb` are built in this repo already.

See `dist/README.md` for the current file list.

---

## Develop (rebuild from source)

Need **Node.js** 20+ and **npm**.

```bash
cd Chris-Custom-FLC-MultiOS
npm install
npm test
npm start
```

Dev mode stores data under this folder's gitignored `data/` directory (created empty on first run). **Do not** copy `servers.json` from any other machine or from Chris' Custom FLC.

### Build installers

From this repo (never from `~/Desktop/Chris-Custom-FLC`):

```bash
npm run dist:linux    # AppImage + .deb  (run on Linux)
npm run dist:win      # NSIS .exe        (Linux with electron-builder, or Windows)
npm run dist:mac      # .dmg             (macOS only)
```

`scripts/pre-dist.sh` **fails** if `data/servers.json` or `logs/*.log` exist, so personal files cannot be packed.

Packaged apps write JSON only under Electron **userData** (paths above). That JSON is created empty on first launch.

### GitHub Actions

`.github/workflows/build-installers.yml` builds Linux, Windows, and macOS artifacts on push/tag so a Mac runner can produce the `.dmg`. Download those artifacts into `dist/` and commit with Git LFS if you keep installers in git.

---

## Security

Usernames and passwords you type in the app are stored **as plain text** in that install's `servers.json` (file mode `0600` on Unix). Logs redact credentials. Do not put secrets you care about in this app.

---

## What this is not

- Not the original **Chris' Custom FLC** Desktop install
- Does not import official Foundry Light Client (`com.phenomen.flc`) data
- Does not ship a pre-filled server list
