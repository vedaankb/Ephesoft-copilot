#!/usr/bin/env bash
# First-time setup for Ephesoft Copilot (Mac / Linux)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "=============================================="
echo " Ephesoft Copilot — install"
echo "=============================================="
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found. Install Python 3.11+ from https://www.python.org/downloads/"
  exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: Node.js/npm not found. Install from https://nodejs.org/"
  exit 1
fi

echo "→ Python: $(python3 --version)"
echo "→ Node:   $(node --version)"
echo

echo "→ Creating virtual environment..."
python3 -m venv .venv

echo "→ Installing Python packages..."
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -r requirements.txt -q

echo "→ Installing Node packages..."
npm install --silent

echo "→ Creating config.json..."
.venv/bin/python setup.py

chmod +x launch.sh 2>/dev/null || true
if [[ -f "Start Ephesoft Copilot.command" ]]; then
  chmod +x "Start Ephesoft Copilot.command"
fi

echo
echo "=============================================="
echo " Install complete"
echo "=============================================="
echo
echo "Next steps:"
echo "  1. Chrome → chrome://extensions → Developer mode → Load unpacked → extension/"
echo "  2. Run:  ./launch.sh"
echo "  3. Panel → gear icon → add Gemini API key"
echo
echo "See INSTALL.md for full instructions."
