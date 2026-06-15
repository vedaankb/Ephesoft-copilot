#!/usr/bin/env python3
"""Entry point for the packaged FastAPI server (PyInstaller bundle)."""

import os
import sys
from pathlib import Path


def _bootstrap_bundle_paths() -> None:
    if getattr(sys, "frozen", False):
        bundle = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
        os.environ.setdefault("EPHESOFT_COPILOT_RESOURCES", str(bundle))


def main() -> None:
    _bootstrap_bundle_paths()
    import uvicorn

    uvicorn.run(
        "server.main:app",
        host="127.0.0.1",
        port=8000,
        log_level="info",
    )


if __name__ == "__main__":
    main()
