# Ephesoft Copilot - Chrome Extension (V2)

A self-contained Chrome extension. No backend, no Electron, no Playwright. It reads the
document on the active Ephesoft tab with Gemini Vision and fills the fields, one safe action
at a time. The human always performs Validate.

## Install (dev / unpacked)

1. Open `chrome://extensions` (Chrome 114+; works in Edge too).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Click the extension's toolbar icon to open the side panel.
5. In **Settings**, paste your Gemini API key (from https://aistudio.google.com/apikey),
   pick a model, click **Test key**, then **Save**.

## How it works

- **sidepanel.\*** - the UI (Fill / Next / Stop, activity feed, settings).
- **service_worker.js** - the agent loop: capture screenshot + page text, ask Gemini for the
  next action, execute it, repeat until complete/incomplete.
- **content_script.js** - reads the page and performs fill/select/click/scroll with realistic
  events; enforces a runtime guard that blocks Validate/Skip/Merge/Split/Submit clicks.
- **lib/gemini.js** - tiny REST client for the Gemini API (plain HTTPS).
- **prompts/** - the SOP and document-type rules, injected into every Gemini call (RAG).

## Safety

- Never clicks Validate / Skip / Merge / Split / Submit - blocked in the content script.
- The API key is stored in `chrome.storage.local` for this profile and sent only to Google's
  Gemini API over HTTPS.
- Stops on the Stop button after the current step.

## Permissions

- `sidePanel`, `scripting`, `tabs`, `activeTab`, `storage`
- `host_permissions`: `<all_urls>` (read/act on the Ephesoft page + screenshots) and
  `https://generativelanguage.googleapis.com/*` (Gemini API).
