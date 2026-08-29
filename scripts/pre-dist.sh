#!/usr/bin/env bash
# Fail closed: never package developer personal data or live logs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

fail() {
  echo "pre-dist: $*" >&2
  exit 1
}

if [[ "$(basename "$REPO")" == "Chris-Custom-FLC" ]]; then
  fail "refusing to run inside original Chris-Custom-FLC"
fi

if [[ -f "$REPO/data/servers.json" ]]; then
  fail "data/servers.json exists — remove it before packaging (each install creates its own empty JSON)"
fi

if ls "$REPO/logs"/*.log >/dev/null 2>&1; then
  fail "logs/*.log exist — delete logs before packaging"
fi

if grep -R -n --include='*.js' --include='*.html' \
  -e 'Chris-Custom-FLC/data' \
  -e 'com.phenomen.flc' \
  "$REPO/electron" "$REPO/src" 2>/dev/null; then
  fail "source still references original install data or official FLC share path"
fi

echo "pre-dist: ok"
