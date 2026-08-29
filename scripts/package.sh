#!/usr/bin/env bash
# MultiOS packaging lives in npm run dist:*  — do not write to the original FLC installer path.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec npm run dist:linux
