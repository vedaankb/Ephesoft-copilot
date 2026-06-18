#!/usr/bin/env python3
"""
First-run setup helper.

In the new architecture the Gemini API key is entered in the Electron panel's
Settings modal (and stored in the OS keychain via the FastAPI backend), so
this script only:
  1. Creates a default config.json (if missing)
  2. Reminds you how to install Playwright is no longer required — but Chromium
     for the browser extension is what you launch normally
  3. Prints next steps
"""

import json
import sys
from pathlib import Path


DEFAULT_CONFIG = {
    "GEMINI_MODEL": "gemini-3.1-pro-preview",
    "MAX_RETRIES": 2,
    "LOG_SCREENSHOTS": True,
    "LOG_ACTIONS": True,
}


def ensure_config():
    cfg_path = Path.cwd() / "config.json"
    if cfg_path.exists():
        print(f"✓ config.json already exists at {cfg_path}")
        return
    with open(cfg_path, "w") as f:
        json.dump(DEFAULT_CONFIG, f, indent=2)
    print(f"✓ Created {cfg_path}")


def main():
    print()
    print("=" * 50)
    print("Ephesoft Copilot — first-run setup")
    print("=" * 50)
    print()

    ensure_config()

    print()
    print("Next steps:")
    print("  1. Install dependencies:")
    print("       python3 -m venv .venv")
    print("       .venv/bin/pip install -r requirements.txt")
    print("       npm install")
    print()
    print("  2. Load the browser extension in Chrome:")
    print("       chrome://extensions  →  Developer mode  →  Load unpacked  →  ./extension")
    print()
    print("  3. Start the app:")
    print("       .venv/bin/python run.py")
    print()
    print("  4. In the Electron panel, click the gear (⚙) and paste your")
    print("     Gemini API key from https://aistudio.google.com/apikey")
    print()


if __name__ == "__main__":
    main()
