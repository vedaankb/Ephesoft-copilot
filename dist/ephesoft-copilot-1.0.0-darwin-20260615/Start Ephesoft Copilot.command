#!/bin/bash
# Double-click launcher for macOS (run install.sh once first)
cd "$(dirname "$0")"
if [[ ! -d ".venv" ]]; then
  osascript -e 'display alert "Ephesoft Copilot" message "Run install.sh first (see INSTALL.md)."'
  exit 1
fi
exec ./launch.sh
