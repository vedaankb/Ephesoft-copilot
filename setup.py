#!/usr/bin/env python3
"""
First-run setup wizard for Ephesoft Copilot.

Tasks:
1. Collect API keys and Ephesoft URL
2. Store credentials in OS keychain
3. Create config.json
4. Optionally capture fixture HTML from live portal
"""

import json
import sys
from pathlib import Path
from getpass import getpass


def setup_keyring():
    """Store credentials in OS keychain."""
    print("\n" + "=" * 50)
    print("Credential Setup")
    print("=" * 50)
    print()
    
    try:
        import keyring
    except ImportError:
        print("✗ keyring package not installed")
        print("Run: pip install keyring")
        sys.exit(1)
    
    # Gemini API key
    print("Gemini API Key (Google AI Studio — must start with AIza):")
    print("Create one at: https://aistudio.google.com/apikey")
    gemini_key = getpass("Enter Gemini API key (hidden): ").strip()
    
    if gemini_key:
        if not gemini_key.startswith("AIza"):
            print("⚠ Warning: Key should start with 'AIza'. Wrong keys cause 401 errors.")
        keyring.set_password("ephesoft-copilot", "GEMINI_API_KEY", gemini_key)
        print("✓ Gemini API key stored in keychain")
        return gemini_key
    else:
        print("⚠ No Gemini API key provided - add to config.json before using Fill")
    
    print()
    return None


def create_config(gemini_key=None):
    """Create config.json from user input."""
    print("\n" + "=" * 50)
    print("Configuration")
    print("=" * 50)
    print()
    
    # Load example config
    example_path = Path.cwd() / "config.example.json"
    with open(example_path) as f:
        config = json.load(f)
    
    # Ephesoft URL
    print("Ephesoft URL:")
    ephesoft_url = input("Enter Ephesoft portal URL (e.g., https://ephesoft.company.com): ").strip()
    config["EPHESOFT_URL"] = ephesoft_url
    
    # Mock mode
    print("\nMock Mode:")
    print("Set to true to develop against local fixtures instead of live portal")
    mock_mode = input("Enable mock mode? (y/N): ").strip().lower()
    config["MOCK"] = mock_mode == 'y'
    
    # Also store key in config.json (gitignored) as reliable fallback for keychain issues
    if gemini_key:
        config["GEMINI_API_KEY"] = gemini_key

    # Write config.json
    config_path = Path.cwd() / "config.json"
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    
    print(f"\n✓ Created {config_path}")
    print()


def capture_fixtures():
    """Guide user through capturing fixture HTML."""
    print("\n" + "=" * 50)
    print("Fixture Capture (Optional)")
    print("=" * 50)
    print()
    print("To enable mock mode, you need to capture Ephesoft HTML pages:")
    print()
    print("1. Open Ephesoft in Chrome")
    print("2. Navigate to a batch with field view open")
    print("3. Right-click → Save As → 'Webpage, Complete'")
    print("4. Save as: fixtures/field_view.html")
    print()
    print("5. Navigate to batch list page")
    print("6. Right-click → Save As → 'Webpage, Complete'")
    print("7. Save as: fixtures/batch_list.html")
    print()
    
    input("Press Enter when done (or skip for now)...")
    
    # Check if fixtures exist
    fixtures_dir = Path.cwd() / "fixtures"
    field_view = fixtures_dir / "field_view.html"
    batch_list = fixtures_dir / "batch_list.html"
    
    if field_view.exists():
        print("✓ field_view.html found")
    else:
        print("⚠ field_view.html not found")
    
    if batch_list.exists():
        print("✓ batch_list.html found")
    else:
        print("⚠ batch_list.html not found")
    
    print()


def main():
    """Run setup wizard."""
    print()
    print("=" * 50)
    print("Ephesoft Copilot - First-Run Setup")
    print("=" * 50)
    print()
    print("This wizard will:")
    print("- Store credentials in OS keychain")
    print("- Create config.json")
    print("- Guide you through fixture capture")
    print()
    
    proceed = input("Continue? (Y/n): ").strip().lower()
    if proceed == 'n':
        print("Setup cancelled")
        sys.exit(0)
    
    # Run setup steps
    gemini_key = setup_keyring()
    create_config(gemini_key=gemini_key)
    
    # Ask about fixture capture
    capture = input("Capture fixtures now? (y/N): ").strip().lower()
    if capture == 'y':
        capture_fixtures()
    
    # Done
    print("=" * 50)
    print("Setup complete!")
    print("=" * 50)
    print()
    print("Next steps:")
    print("1. Install Playwright browsers:")
    print("   .venv/bin/python -m playwright install chromium")
    print("2. Run the app:")
    print("   .venv/bin/python run.py")
    print()


if __name__ == "__main__":
    main()
