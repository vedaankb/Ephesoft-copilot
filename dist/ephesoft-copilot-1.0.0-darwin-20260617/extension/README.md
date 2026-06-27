# Ephesoft Copilot — Browser Extension

Acts as the "DOM hands" for the Electron panel.

## Install (dev / unpacked)

1. Make sure the FastAPI backend is running (`.venv/bin/python run.py` or
   the Electron app, which spawns it).
2. Open `chrome://extensions` (works in Edge too).
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and pick this `extension/` folder.
5. The extension's popup should show **Connected to backend** within a
   second or two. The Electron panel's `ext` dot will turn green.

## What it does

- Connects to `ws://127.0.0.1:8000/ws/extension`.
- Receives a closed set of commands (`fill`, `click`, `select`, `get_html`,
  `screenshot`, `active_tab_url`).
- Anything outside that list is rejected before it reaches the page.
- It also refuses to click any element whose label looks like Validate /
  Skip / Merge / Split — defense in depth.

## What it does not do

- It does **not** read the user's API key.
- It does **not** call Gemini directly.
- It does **not** decide what to fill — only translates a single low-level
  command at a time.
- It does **not** click Validate. Ever.

## Icons

The manifest references `icon16.png`, `icon48.png`, `icon128.png`. Chrome
will load fine without them; add real icons later before publishing.
