#!/usr/bin/env bash
# Build a downloadable zip of Ephesoft Copilot (source + install scripts, no venv/node_modules).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.0")"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
STAMP="$(date -u +%Y%m%d)"
PKG_NAME="ephesoft-copilot-${VERSION}-${OS}-${STAMP}"
STAGING="$ROOT/dist/$PKG_NAME"
ARCHIVE="$ROOT/dist/${PKG_NAME}.zip"

echo "Building $PKG_NAME ..."

rm -rf "$STAGING"
mkdir -p "$STAGING" "$ROOT/dist"

# Copy app files (explicit list — keeps package small and predictable)
copy_tree() {
  local src="$1"
  if [[ -d "$src" ]]; then
    mkdir -p "$STAGING/$src"
    rsync -a \
      --exclude '__pycache__' \
      --exclude '*.pyc' \
      --exclude '.DS_Store' \
      "$src/" "$STAGING/$src/"
  fi
}

for dir in server electron extension prompts fixtures tests scripts; do
  copy_tree "$dir"
done

for file in \
  requirements.txt \
  package.json \
  package-lock.json \
  config.example.json \
  setup.py \
  run.py \
  README.md \
  INSTALL.md \
  install.sh \
  launch.sh \
  install.ps1 \
  launch.ps1 \
  "Start Ephesoft Copilot.command" \
  sop_rules.md
do
  if [[ -f "$ROOT/$file" ]]; then
    cp "$ROOT/$file" "$STAGING/$file"
  fi
done

# Package metadata
cat > "$STAGING/PACKAGE_INFO.json" <<EOF
{
  "name": "ephesoft-copilot",
  "version": "${VERSION}",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platform": "${OS}",
  "install_mac_linux": "./install.sh",
  "install_windows": ".\\\\install.ps1",
  "launch_mac_linux": "./launch.sh",
  "launch_windows": ".\\\\launch.ps1",
  "extension_path": "extension/"
}
EOF

chmod +x "$STAGING/install.sh" "$STAGING/launch.sh" 2>/dev/null || true
chmod +x "$STAGING/Start Ephesoft Copilot.command" 2>/dev/null || true

rm -f "$ARCHIVE"
(cd "$ROOT/dist" && zip -rq "$(basename "$ARCHIVE")" "$(basename "$STAGING")")

echo
echo "Created: $ARCHIVE"
echo "Size:    $(du -h "$ARCHIVE" | cut -f1)"
echo
echo "To distribute:"
echo "  1. Send the .zip file"
echo "  2. Recipient unzips, runs install.sh (or install.ps1 on Windows)"
echo "  3. Loads extension/ in Chrome, then launch.sh"
