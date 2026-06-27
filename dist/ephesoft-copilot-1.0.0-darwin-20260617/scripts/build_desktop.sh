#!/usr/bin/env bash
# Build one-click desktop installer (DMG on Mac, NSIS .exe on Windows).
# Usage:
#   ./scripts/build_desktop.sh mac
#   ./scripts/build_desktop.sh win
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="${1:-}"

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) TARGET="mac" ;;
    MINGW*|MSYS*|CYGWIN*) TARGET="win" ;;
    *)
      echo "Usage: $0 mac|win"
      exit 1
      ;;
  esac
fi

echo "Building desktop installer for: $TARGET"
bash scripts/build_server.sh

if [[ ! -d "node_modules/electron-builder" ]] && [[ ! -d "node_modules" ]]; then
  npm install
fi

npm install --save-dev electron-builder@^24.13.3 2>/dev/null || true

case "$TARGET" in
  mac)
    npx electron-builder --mac dmg
  ;;
  win)
    npx electron-builder --win nsis
  ;;
  *)
    echo "Unknown target: $TARGET (use mac or win)"
    exit 1
    ;;
esac

echo
echo "Installers written to dist/desktop/"
