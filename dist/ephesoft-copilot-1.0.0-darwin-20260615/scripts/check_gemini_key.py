#!/usr/bin/env python3
"""Verify Gemini API key is loaded and accepted by the API."""

import json
import sys
from pathlib import Path

# Project root on path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv
load_dotenv(ROOT / ".env")

from server.credentials import load_gemini_api_key, validate_gemini_api_key, configure_gemini


def main():
    config_path = ROOT / "config.json"
    config = {}
    if config_path.exists():
        with open(config_path) as f:
            config = json.load(f)

    key = load_gemini_api_key(config)
    if not key:
        print("✗ No API key found (env, keychain, or config.json)")
        print("  Get one: https://aistudio.google.com/apikey")
        sys.exit(1)

    print(f"✓ Key loaded ({len(key)} chars, prefix: {key[:8]}...)")

    try:
        validate_gemini_api_key(key)
        print("✓ Format looks valid (AIza...)")
    except ValueError as e:
        print(f"✗ {e}")
        sys.exit(1)

    try:
        configure_gemini(key)
        import google.generativeai as genai
        model = genai.GenerativeModel("gemini-1.5-flash")
        response = model.generate_content("Reply with exactly: ok")
        print(f"✓ API call succeeded: {response.text.strip()[:50]}")
    except Exception as e:
        print(f"✗ API call failed: {e}")
        print("\nFix:")
        print("  1. Create a NEW key at https://aistudio.google.com/apikey")
        print("  2. .venv/bin/python setup.py  (paste the key when prompted)")
        print("  OR add to config.json: \"GEMINI_API_KEY\": \"AIza...\"")
        print("  OR: export GEMINI_API_KEY='AIza...'")
        sys.exit(1)


if __name__ == "__main__":
    main()
