#!/usr/bin/env bash
# Start Ephesoft Copilot (Mac / Linux)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -d ".venv" ]]; then
  echo "Virtual environment not found. Run ./install.sh first."
  exit 1
fi

if [[ ! -f "config.json" ]]; then
  echo "config.json missing. Run ./install.sh first."
  exit 1
fi

exec .venv/bin/python run.py
