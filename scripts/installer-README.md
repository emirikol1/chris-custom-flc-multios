# Packaging

Build installers from the repository root:

```bash
npm run dist:linux   # AppImage + .deb
npm run dist:win     # Windows NSIS installer
npm run dist:mac     # macOS DMG
```

End-user install instructions and the full feature list are in the [project README](../README.md).

This project is inspired by [Foundry Lightweight Client](https://github.com/phenomen/flc) (`https://github.com/phenomen/flc`).

CI workflow: [`.github/workflows/build-installers.yml`](../.github/workflows/build-installers.yml).
