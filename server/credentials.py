"""
Load and validate Gemini API key.

Order: GEMINI_API_KEY env var → OS keychain → config.json

Google AI Studio keys usually start with "AIza".
"""

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

KEYRING_SERVICE = "ephesoft-copilot"
KEYRING_USERNAME = "GEMINI_API_KEY"


def _strip_key(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    key = raw.strip().strip('"').strip("'")
    return key or None


def load_gemini_api_key(config: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """Load Gemini API key from environment, keychain, or config."""
    config = config or {}

    env_key = _strip_key(os.environ.get("GEMINI_API_KEY"))
    if env_key:
        logger.debug("Using GEMINI_API_KEY from environment")
        return env_key

    try:
        import keyring
        keychain_key = _strip_key(keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME))
        if keychain_key:
            logger.debug("Using GEMINI_API_KEY from OS keychain")
            return keychain_key
    except Exception as e:
        logger.warning(f"Could not read keychain: {e}")

    config_key = _strip_key(config.get("GEMINI_API_KEY"))
    if config_key:
        logger.debug("Using GEMINI_API_KEY from config.json")
        return config_key

    return None


def validate_gemini_api_key(api_key: str) -> None:
    """
    Validate key format before calling the API.
    Raises ValueError with actionable message if invalid.
    """
    if not api_key:
        raise ValueError(
            "GEMINI_API_KEY is missing. Get a key at https://aistudio.google.com/apikey "
            "then either:\n"
            "  1. Re-run: .venv/bin/python setup.py\n"
            "  2. Add to config.json: \"GEMINI_API_KEY\": \"AIza...\"\n"
            "  3. Export: export GEMINI_API_KEY='AIza...'"
        )

    if api_key.lower().startswith("bearer "):
        raise ValueError(
            "GEMINI_API_KEY looks like an OAuth Bearer token, not a Google AI Studio API key. "
            "Create an API key at https://aistudio.google.com/apikey (starts with AIza)."
        )

    if api_key.startswith("{") or "private_key" in api_key:
        raise ValueError(
            "GEMINI_API_KEY looks like a service-account JSON file. "
            "Use a Google AI Studio API key from https://aistudio.google.com/apikey instead."
        )

    if not api_key.startswith("AIza"):
        logger.warning(
            "GEMINI_API_KEY does not start with 'AIza' — may be invalid for Google AI Studio"
        )

    if len(api_key) < 30:
        raise ValueError(
            "GEMINI_API_KEY is too short. Copy the full key from "
            "https://aistudio.google.com/apikey"
        )


def configure_gemini(api_key: str):
    """Configure google-generativeai with the API key."""
    import google.generativeai as genai
    validate_gemini_api_key(api_key)
    genai.configure(api_key=api_key)


def save_gemini_api_key(api_key: str) -> None:
    """Persist API key to OS keychain (raises if invalid)."""
    api_key = (api_key or "").strip()
    validate_gemini_api_key(api_key)
    import keyring
    keyring.set_password(KEYRING_SERVICE, KEYRING_USERNAME, api_key)
    logger.info("Saved Gemini API key to keychain")


def clear_gemini_api_key() -> None:
    """Remove API key from keychain (no error if missing)."""
    try:
        import keyring
        keyring.delete_password(KEYRING_SERVICE, KEYRING_USERNAME)
        logger.info("Cleared Gemini API key from keychain")
    except Exception as e:
        logger.warning(f"Could not clear keychain: {e}")


async def test_gemini_api_key(api_key: str) -> dict:
    """Make a tiny call to verify the key works. Returns {ok, message}."""
    import google.generativeai as genai
    try:
        validate_gemini_api_key(api_key)
    except ValueError as e:
        return {"ok": False, "message": str(e)}
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-3.1-pro-preview")
        response = await model.generate_content_async("Reply with: ok")
        text = (response.text or "").strip()
        return {"ok": True, "message": f"Key works (model replied: {text[:40]})"}
    except Exception as e:
        err = str(e)
        if "401" in err or "ACCESS_TOKEN" in err or "authentication" in err.lower():
            return {"ok": False, "message": "401: key was rejected by Google. Create a fresh key at https://aistudio.google.com/apikey"}
        return {"ok": False, "message": f"API error: {err[:200]}"}
