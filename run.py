#!/usr/bin/env python3
"""
Ephesoft Copilot launcher.

Starts FastAPI server, then launches Electron app.
"""

import sys
import subprocess
import shutil
import time
import os
from pathlib import Path


def find_electron():
    """Locate the local Electron binary (handles Windows .cmd)."""
    base = Path.cwd() / "node_modules" / ".bin"
    candidates = [base / "electron.cmd", base / "electron"]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def check_dependencies():
    """Check that required dependencies are installed."""
    print("Checking dependencies...")
    
    # Check Python packages
    try:
        import fastapi
        import google.generativeai
        import keyring
        print("✓ Python dependencies OK")
    except ImportError as e:
        print(f"✗ Missing Python dependency: {e}")
        print("Run: pip install -r requirements.txt")
        sys.exit(1)
    
    # Check Node/npm for Electron. shutil.which() resolves npm.cmd on Windows,
    # which a bare subprocess(["npm", ...]) call does not.
    if shutil.which("node") is None:
        print("✗ Node.js not installed")
        print("Install Node.js from: https://nodejs.org/")
        sys.exit(1)

    npm = shutil.which("npm") or shutil.which("npm.cmd")

    # Install Node deps if missing (or if Electron itself isn't there yet).
    if not (Path.cwd() / "node_modules").exists() or find_electron() is None:
        if npm is None:
            print("✗ npm not found. Reinstall Node.js from https://nodejs.org/")
            sys.exit(1)
        print("Installing Node dependencies...")
        subprocess.run([npm, "install"], check=True, shell=(os.name == "nt"))

    print("✓ Node.js OK")
    print("All dependencies OK\n")


def check_config():
    """Check that config.json exists."""
    config_path = Path.cwd() / "config.json"
    
    if not config_path.exists():
        print("✗ config.json not found")
        print("Run: python setup.py")
        print("Or copy: cp config.example.json config.json")
        sys.exit(1)
    
    print("✓ config.json found")


def start_electron():
    """Start Electron app directly via its local binary (no npm needed)."""
    print("\nStarting Electron app...")

    electron = find_electron()
    if electron is None:
        print("✗ Electron not found in node_modules. Run install first.")
        sys.exit(1)

    try:
        subprocess.run([electron, "."], check=True, shell=(os.name == "nt"))
    except KeyboardInterrupt:
        print("\nShutting down...")
    except subprocess.CalledProcessError as e:
        print(f"✗ Failed to start Electron: {e}")
        sys.exit(1)


def main():
    """Main entry point."""
    print("=" * 50)
    print("Ephesoft Copilot")
    print("=" * 50)
    print()
    
    # Check dependencies
    check_dependencies()
    
    # Check config
    check_config()
    
    # Create logs directories if they don't exist
    (Path.cwd() / "logs" / "actions").mkdir(parents=True, exist_ok=True)
    (Path.cwd() / "logs" / "screenshots").mkdir(parents=True, exist_ok=True)

    # Start Electron (which will spawn FastAPI server)
    start_electron()

if __name__ == "__main__":
    main()
