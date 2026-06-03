#!/usr/bin/env python3
"""
Ephesoft Copilot launcher.

Starts FastAPI server, then launches Electron app.
"""

import sys
import subprocess
import time
import os
from pathlib import Path


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
    
    # Check Node/npm for Electron
    try:
        subprocess.run(["node", "--version"], capture_output=True, check=True)
        subprocess.run(["npm", "--version"], capture_output=True, check=True)
        print("✓ Node.js OK")
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("✗ Node.js not installed")
        print("Install Node.js from: https://nodejs.org/")
        sys.exit(1)
    
    # Check if node_modules exists
    if not (Path.cwd() / "node_modules").exists():
        print("Installing Node dependencies...")
        subprocess.run(["npm", "install"], check=True)
    
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
    """Start Electron app."""
    print("\nStarting Electron app...")
    
    try:
        subprocess.run(["npm", "start"], check=True)
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
