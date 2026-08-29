#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

unset ELECTRON_RUN_AS_NODE

ELECTRON_BIN="$DIR/node_modules/.bin/electron"
if [[ ! -x "$ELECTRON_BIN" ]]; then
  ELECTRON_BIN="$DIR/node_modules/electron/dist/electron"
fi

if [[ ! -x "$ELECTRON_BIN" ]]; then
  echo "Chris's Custom FLC MultiOS: Electron not found. Run 'npm install' in:" >&2
  echo "  $DIR" >&2
  exit 1
fi

exec "$ELECTRON_BIN" . "$@"
