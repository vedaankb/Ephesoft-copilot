# Ephesoft Copilot — Install Guide

Quick setup for the download package (Mac / Linux / Windows).

## Requirements

- **Python 3.11+** — [python.org](https://www.python.org/downloads/)
- **Node.js 18+** — [nodejs.org](https://nodejs.org/)
- **Google Chrome** (for the browser extension)
- **Gemini API key** — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (starts with `AIza`)

## 1. Install

### Mac / Linux

```bash
cd ephesoft-copilot-*
chmod +x install.sh launch.sh
./install.sh
```

Or double-click **`Start Ephesoft Copilot.command`** (Mac only, after running `install.sh` once).

### Windows

Open PowerShell in this folder:

```powershell
.\install.ps1
```

Then start with:

```powershell
.\launch.ps1
```

## 2. Load the Chrome extension (one time)

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the **`extension`** folder inside this package

The extension popup should show **Connected to backend** once the app is running.

## 3. Run

### Mac / Linux

```bash
./launch.sh
```

### Windows

```powershell
.\launch.ps1
```

The floating panel opens. Both header dots should turn green when the extension is connected:

- **panel** — Electron ↔ backend
- **ext** — Chrome extension ↔ backend

## 4. First run in the panel

1. Click the **gear** icon
2. Paste your Gemini API key → **Test key** → **Save**
3. Log into Ephesoft in Chrome as you normally do
4. On the batch list page, click **Next**; on a claim, click **Fill**

## Mock testing (no real Ephesoft)

With the app running, open in Chrome:

- `http://127.0.0.1:8000/mock/batch_list`
- `http://127.0.0.1:8000/mock/field_view`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Red `panel` dot | Re-run `./launch.sh`; wait a few seconds |
| Red `ext` dot | Reload extension at `chrome://extensions` |
| Gemini 401 | Use a fresh `AIza…` key in Settings |
| `Python not found` | Re-run `./install.sh` or install Python 3.11+ |

Check API key outside the app:

```bash
.venv/bin/python scripts/check_gemini_key.py
```

## Safety reminder

The tool **never clicks Validate**. You review every batch and validate yourself in Ephesoft.

---

## Desktop installer (DMG / Windows .exe)

If you installed from **`Ephesoft-Copilot-*-mac.dmg`** or **`Ephesoft-Copilot-*-win-setup.exe`**:

1. Install and open **Ephesoft Copilot** from Applications / Start Menu
2. On first launch, follow the prompt to **Load unpacked** → select the `extension` folder (the app can open it for you)
3. Panel → **gear** → add Gemini API key
4. Use Ephesoft in Chrome as usual → **Next** / **Fill**

No Python or Node install required for desktop builds.

