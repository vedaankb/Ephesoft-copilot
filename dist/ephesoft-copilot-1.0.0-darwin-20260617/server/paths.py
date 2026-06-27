"""
Resolve app paths for dev vs packaged (PyInstaller + Electron) runs.

- EPHESOFT_COPILOT_RESOURCES: read-only bundle (prompts, fixtures) — set by Electron
- EPHESOFT_COPILOT_HOME: writable user data (config.json, logs) — set by Electron
"""

import os
from pathlib import Path


def get_resources_root() -> Path:
    """Bundled assets directory (prompts, fixtures)."""
    env = os.environ.get("EPHESOFT_COPILOT_RESOURCES")
    if env:
        return Path(env)
    return Path.cwd()


def get_app_root() -> Path:
    """Writable app data directory (config, logs)."""
    env = os.environ.get("EPHESOFT_COPILOT_HOME")
    if env:
        return Path(env)
    return Path.cwd()


def resource_path(*parts: str) -> Path:
    return get_resources_root().joinpath(*parts)
