# Ephesoft Copilot (V2 - Pure Chrome Extension)

Ephesoft Copilot is a secure Chrome extension that automates tedious data entry for agents working in the Ephesoft document-processing portal. It reads the document on screen with Gemini Vision, fills the claim fields, and keeps the human firmly in control - the agent always performs the final Validate.

**V2 is a 100% Chrome extension.** There is no Python, no Electron, no local server, and no Playwright to install. That removes every install-time failure mode from V1 (port binding, firewall/SSL/proxy issues, virtual environments, native builds). Deployment is now just "install a Chrome extension."

---

## 1. Architecture

Everything runs inside Chrome. The extension talks directly to the Gemini API over normal HTTPS, which corporate proxies already trust.

```
┌─────────────────────────────┐        ┌────────────────────────────┐
│  Side Panel (sidepanel.*)   │        │  Gemini API (HTTPS fetch)  │
│  Fill / Next / Stop, status │        │  vision + reasoning + SOP  │
└──────────────┬──────────────┘        └─────────────▲──────────────┘
               │ port                                 │
               ▼                                       │
┌─────────────────────────────┐  screenshot + 1 action│
│  Service Worker (agent loop) │───────────────────────┘
│  observe → think → act → ↺  │
└──────────────┬──────────────┘
               │ chrome.tabs.sendMessage
               ▼
┌─────────────────────────────┐
│  Content Script (DOM ctrl)  │  reads HTML/text, fills, clicks
│  + runtime safety guard     │  scrolls, paginates - in the page
└─────────────────────────────┘
               │
               ▼
        Active Ephesoft tab (the agent's real, logged-in session)
```

### Components
- **Side Panel** (`extension/sidepanel.html|css|js`): the UI - Fill, Next, Stop, a live activity feed, a result card, and Settings (API key + model). Persistent and resizable via Chrome's native Side Panel.
- **Service Worker** (`extension/service_worker.js`): the orchestrator. It runs a dynamic, step-by-step agent loop, captures screenshots, loads the SOP prompts (RAG), and calls Gemini.
- **Content Script** (`extension/content_script.js`): the "hands." It reads the page and performs fills/clicks/scrolls with realistic events, and enforces a runtime safety guard.
- **Gemini client** (`extension/lib/gemini.js`): a tiny zero-dependency REST wrapper.
- **Prompts / SOP (RAG)** (`extension/prompts/*.md`): the Wombat/IPG SOP, document-type rules, and agent instructions, injected as the system instruction on every Gemini call.

### Dynamic step-by-step agent loop
Instead of planning everything up front, the agent works one action at a time:
1. **Observe** - capture a screenshot of the active tab + read cleaned HTML/visible text.
2. **Reason** - send the screenshot, page text, action history, and the SOP to Gemini.
3. **Act** - Gemini returns exactly one action: `fill`, `select`, `click`, `scroll`, `complete`, or `incomplete`.
4. **Execute** - the content script performs it.
5. **Settle & repeat** until Gemini calls `complete`/`incomplete` or a step limit is hit.

This naturally handles slow pages, multi-page documents, multi-row line-item tables, and multi-page batch lists.

---

## 2. Use Case

In high-volume BPO operations, agents process hundreds of claims daily. Manually:
1. Open a batch, scroll the invoice/receipt.
2. Type Invoice Date, Number, Provider, Pet Name.
3. Compute and type net/invoice totals.
4. Clear and re-type every line item.
5. Click Validate.

With Copilot:
1. Log into Ephesoft in Chrome as usual.
2. Open the Copilot side panel (click the toolbar icon).
3. Click **Next** - the agent finds and opens the oldest unassigned batch (paging through the batch list if needed).
4. Click **Fill** - the agent reads the document, scrolls as needed, and fills all fields and line items.
5. **The human reviews and clicks Validate.**

---

## 3. Install

### Prerequisites
- Google Chrome 114+ (for the Side Panel API).
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) (starts with `AIza`).

### Load the extension (developer / pilot)
1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` folder of this repo.
4. Pin the extension and click its icon to open the side panel.

### Install from a packaged zip
1. Build it: `node scripts/package_extension.js` → produces `dist/ephesoft-copilot-extension-v<version>.zip`.
2. Unzip, then **Load unpacked** on the unzipped folder (or upload the zip to the Chrome Web Store / enterprise admin policy for fleet deployment).

### First-run setup
1. Click the Copilot toolbar icon to open the side panel.
2. Open **Settings**, paste your Gemini API key, pick a model (default `gemini-2.5-pro`), click **Test key**, then **Save**. The key is stored in `chrome.storage.local` for this browser profile and is sent only to Google's Gemini API over HTTPS.

---

## 4. Safety (human-in-the-loop)

- **Never auto-validates.** The loop ends by presenting filled fields; the human performs Validate.
- **Runtime click guard** (`content_script.js`): before any click, the target (and its closest button/link) is inspected; clicks whose text/id/class/aria match `validate`, `skip`, `merge document`, `split document`, `submit`, or `delete batch` are blocked and reported back to the model. This lets the agent freely click safe navigation (next document page, tabs, batch-list pagination, add-row) while making destructive actions impossible.
- **No data invention.** The model extracts only what the document shows and follows the SOP; when a required value is missing/unreadable it returns `incomplete` with one of the three SOP reasons (`Missing Invoice`, `Missing Information`, `Illegible Documents`).
- **Stays in Ephesoft.** The agent does not navigate to unrelated sites.
- **Stop anytime.** The Stop button halts the loop after the current step.

---

## 5. Time savings & ROI

Copilot shifts the agent from **manual data entry** to **high-speed verification**.

| Task / Step | Manual | Copilot | Saved |
| :--- | :---: | :---: | :---: |
| Batch selection (filter, sort, open oldest) | 15–30 s | one-click Next | ~20 s |
| Data extraction (dates, totals, provider, pet) | 30–60 s | Gemini Vision | ~40 s |
| Form filling (fields, date formats, symbols) | 30–45 s | automated | ~35 s |
| Line items (clear table, descriptions, costs, qty) | 60–120 s | automated | ~90 s |
| Verification & review | 30–45 s | vision pass | ~30 s |
| **Total per claim** | **2.5–5.0 min** | **~20–35 s** | **2–4 min** |

- **~85% reduction in processing time** and **3–5x throughput**.
- **No transcription fatigue** - precise formatting (strips `$`/commas, normalizes dates) per SOP.
- **3–5 hours saved per agent per day** at ~100 claims/day.
- **Zero-configuration deployment** - one Chrome extension, no backend.

---

## 6. Project layout (V2)

```
extension/
├── manifest.json          # MV3 + sidePanel + content script
├── service_worker.js      # agent orchestrator (Gemini loop)
├── content_script.js      # DOM read/write + safety guard
├── sidepanel.html|css|js  # the UI
├── lib/gemini.js          # zero-dep Gemini REST client
└── prompts/               # system.md, sop_rules.md, doc_types.md (RAG/SOP)
scripts/
└── package_extension.js   # builds dist/*.zip for distribution
package.json               # just a `package` script (no runtime deps)
```

> The legacy V1 stack (Python/FastAPI backend, Electron panel, Playwright) has been removed.
> The product is now entirely the Chrome extension above. Build a distributable zip with
> `npm run package` (or `node scripts/package_extension.js`).
