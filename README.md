# Ephesoft Copilot (V2 - Pure Chrome Extension)

Ephesoft Copilot is a secure Chrome and Edge extension that automates tedious data entry for agents working in the Ephesoft document-processing portal. It reads the document on screen with Gemini Vision, fills the claim fields, and keeps the human firmly in control — the agent always performs the final Validate.

**V2 is a 100% Chrome & Edge extension.** No Python, Electron, local server, or Playwright. Deployment is install-the-extension + paste a license key.

### Premium UI
Dark glassmorphism side panel with tactile buttons and subtle floating background animations (dogs, cats, syringes).

---

## Architecture

```
Side Panel (Fill / Next / Stop)
        │ port
        ▼
Service Worker (observe → Gemini → act → repeat)
        │ tabs.sendMessage + screenshot
        ▼
Content Script (DOM fill/click/scroll + safety guard)
        │
        ▼
Active Ephesoft tab (agent's real logged-in session)
```

**RAG / SOP:** `extension/prompts/*.md` are injected as Gemini system instructions on every step.

**Agent loop:** Observe page → ask Gemini for one action → execute → settle → repeat until `complete` / `incomplete` / step limit.

---

## Install

### Prerequisites
- Chrome 114+ or Edge (Chromium) with Side Panel support
- Valid **license key** (see below)
- Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

### Option A — Windows installer (pilots)

```powershell
$url = 'https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1'
$file = "$env:TEMP\ephesoft-install.ps1"
Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing; & $file
```

Creates desktop shortcuts that launch a **dedicated browser profile** with the extension preloaded. **Always use the shortcut** — the extension will not appear in your normal browser profile.

### Option B — Load unpacked (developers)
1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`
2. Pin the toolbar icon and open the side panel

### Option C — Packaged zip (distribution)
```bash
npm install
node scripts/package_extension.js
```
Produces `dist/ephesoft-copilot-extension-v2.0.0.zip` (obfuscated). Unzip → Load unpacked, or deploy via GPO (see `DEPLOYMENT.md`).

### First-run setup
1. Open the side panel → **Settings**
2. Paste your **License Key** → **Save** (status turns green when valid)
3. Paste Gemini API key → **Test key** → **Save**

---

## Licensing

Copilot requires a cryptographically signed offline license key.

| Who | How to get a key |
| :--- | :--- |
| Clients / pilots | Request from the developer — keys are generated per client with an expiration date |
| Developers | `node scripts/generate_license.js --client "Name" --expires "YYYY-MM-DD"` |
| Internal QA | Contact the developer for the internal bypass key (not published in public docs) |

Verification is 100% offline (ECDSA P-256, Web Crypto). No license server.

---

## Safety

- **Never auto-validates** — human clicks Validate
- **Runtime click guard** blocks Validate, Skip, Merge, Split, Submit, Delete
- **No data invention** — missing values → `incomplete` per SOP
- **Stop anytime** — aborts the current Gemini step cleanly

---

## Project layout

```
extension/
├── manifest.json
├── service_worker.js      # agent orchestrator
├── content_script.js      # DOM + safety guard
├── sidepanel.html|css|js  # UI
├── copilot-launcher.bat   # offline Windows launcher
├── managed_schema.json    # GPO policy schema
├── icons/                 # extension icons
├── lib/gemini.js          # Gemini REST client
└── lib/license.js         # offline license verifier
scripts/
├── package_extension.js   # obfuscated zip builder
├── generate_license.js    # license key generator
├── generate_icons.js      # PNG icon generator
└── install_helpers.ps1    # shared Windows installer helpers
install.ps1                # 1-click web bootstrap installer
DEPLOYMENT.md              # IT / GPO deployment guide
QUADRANTECH_TESTING.md     # pilot testing guide (gitignored — share directly)
```

Build: `npm run package` or `node scripts/package_extension.js`

Legacy V1 (Python/Electron/Playwright) has been removed.
