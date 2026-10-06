#!/usr/bin/env bash
set -euo pipefail

# Follow symlinks. The GUI menu runs ~/.local/bin/chris-custom-flc, which is a
# link to this file; dirname of that link is ~/.local/bin, not this project.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  LINK_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$LINK_DIR/$SOURCE"
done
DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
cd "$DIR"

unset ELECTRON_RUN_AS_NODE

# The .bin/electron entry is a Node script. Cinnamon's menu PATH has no node
# (nvm is not loaded), so start the Electron binary itself.
ELECTRON_BIN="$DIR/node_modules/electron/dist/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  ELECTRON_BIN="$DIR/node_modules/.bin/electron"
fi

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Chris's Custom FLC MultiOS: Electron not found. Run 'npm install' in:" >&2
  echo "  $DIR" >&2
  exit 1
fi

exec "$ELECTRON_BIN" . "$@"
