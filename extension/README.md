# Ephesoft Copilot - Chrome Extension (V2)

A self-contained Chrome extension. No backend, no Electron, no Playwright. It reads the
document on the active Ephesoft tab with Gemini Vision and fills the fields. The human
always performs Validate.

## Install (dev / unpacked)

1. Open `chrome://extensions` (Chrome 114+; works in Edge too).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Click the extension's toolbar icon to open the side panel.
5. In **Settings**, paste your Gemini API key (from https://aistudio.google.com/apikey),
   pick a model, click **Test key**, then **Save**.

## How it works

- **sidepanel.\*** - the UI (**Fill Details** / **Fill Line Items** / Next / Stop, activity feed, settings).
- **service_worker.js** - Fill modes: gather context → decide catalog→values into memory → fill at once.
  Next mode: classic observe → one Gemini action → execute loop.
- **content_script.js** - inventories fields/tables, performs fill/select/click/scroll with realistic
  events; enforces a runtime guard that blocks Validate/Skip/Merge/Split/Submit clicks.
- **lib/gemini.js** - tiny REST client for the Gemini API (plain HTTPS).
- **lib/fill_plan.js** - pure helpers for plan sanitization and value normalization.
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
