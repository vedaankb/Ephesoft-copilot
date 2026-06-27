#!/usr/bin/env bash
# Bundle the FastAPI backend with PyInstaller (required before desktop installer build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -d ".venv" ]]; then
  echo "Run ./install.sh first to create .venv"
  exit 1
fi

echo "→ Installing build dependencies..."
.venv/bin/pip install -q -r requirements.txt -r requirements-build.txt

echo "→ Building ephesoft-server bundle..."
rm -rf build dist-server
.venv/bin/pyinstaller ephesoft-server.spec --noconfirm --distpath dist-server --workpath build/pyinstaller

if [[ ! -d "dist-server/ephesoft-server" ]]; then
  echo "ERROR: PyInstaller output not found at dist-server/ephesoft-server"
  exit 1
fi

echo "✓ Server bundle ready: dist-server/ephesoft-server/"
