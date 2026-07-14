# Ephesoft Copilot - Enterprise Deployment & IT Administration Guide

This guide covers deploying and managing **Ephesoft Copilot** across enterprise fleets on **Google Chrome** and **Microsoft Edge** (Windows).

---

## 1. Architecture & Security Overview

Ephesoft Copilot (V2) is a **pure Chrome/Edge extension** (Manifest V3).

| Property | Detail |
| :--- | :--- |
| Local backend | None — no Python, Electron, or background executables |
| Network | HTTPS to `https://generativelanguage.googleapis.com/*` only |
| Data | Screenshots and page text sent only to the configured Gemini API |
| Settings | `chrome.storage.local` or `chrome.storage.managed` (GPO) |
| Licensing | Offline ECDSA (P-256) signature verification — no licensing server |

---

## 2. Recommended: Enterprise Force-Install (Production)

For production fleets, **do not rely on `--load-extension` shortcuts**. Corporate GPO often blocks developer-mode and external extensions. Use **force-install via GPO** instead.

### Google Chrome
1. GPO: `Computer Configuration → Administrative Templates → Google → Google Chrome → Extensions`
2. Policy: **Configure the list of force-installed apps and extensions**
3. Value: `<extension_id>;https://clients2.google.com/service/update2/crx`

**Registry alternative:**
* Path: `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`
* Name: `1` | Type: `REG_SZ`
* Value: `<extension_id>;https://clients2.google.com/service/update2/crx`

### Microsoft Edge
1. GPO: `Computer Configuration → Administrative Templates → Microsoft Edge → Extensions`
2. Policy: **Control which extensions are installed silently**
3. Value: `<extension_id>;https://edge.microsoft.com/extension/update/chrome/v5`

**Registry alternative:**
* Path: `HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist`
* Name: `1` | Type: `REG_SZ`
* Value: `<extension_id>;https://edge.microsoft.com/extension/update/chrome/v5`

See **Section 6** for self-hosted CRX/update.xml when public stores are blocked.

---

## 3. Pilot Deployment (1-Click Installer)

For pilots and QA (non-GPO machines), use the PowerShell bootstrap installer.

**Recommended** (download then run — works on locked-down corporate PowerShell):

```powershell
$url = 'https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1'
$file = "$env:TEMP\ephesoft-install.ps1"
Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing; & $file
```

> Avoid `irm ... | iex` on corporate machines — it can fail with *"cannot bind argument to parameter Path because it is null"*.

### What it does
1. Downloads the latest repo from GitHub.
2. Builds an **obfuscated extension zip** when Node.js is available.
3. Installs to `%LOCALAPPDATA%\EphesoftCopilot`.
4. Creates desktop shortcuts that launch Chrome/Edge with:
   * `--load-extension` pointing at the install folder
   * `--user-data-dir` pointing at `%LOCALAPPDATA%\EphesoftCopilot\profile` (dedicated profile)

### Why a dedicated profile?
Chrome/Edge **ignore `--load-extension`** when an existing browser process is already running on the default profile. A dedicated profile guarantees the extension loads every time via the shortcut.

### Pilot user instructions
* **Always** launch via the desktop shortcut (`Ephesoft Copilot (Chrome)` or `(Edge)`).
* Log into Ephesoft once inside that profile — login persists there.
* Do not expect the extension in the user's normal browser profile.

### Offline alternative
Unzip a release package and run `extension/copilot-launcher.bat` from inside the extension folder.

---

## 3a. Updating an Existing Pilot Install (`update.ps1`)

When a new build is pushed to `main`, existing pilots should run the **updater** instead of a full reinstall. Profile data, license key, and Gemini API settings are preserved.

**Recommended** (download then run — same 3-line pattern as install):

```powershell
$url = 'https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/update.ps1'
$file = "$env:TEMP\ephesoft-update.ps1"
Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing; & $file
```

**Alternative** — run the local copy shipped by install/update:

```powershell
& "$env:LOCALAPPDATA\EphesoftCopilot\update.ps1"
```

Or from Command Prompt / File Explorer:

```
%LOCALAPPDATA%\EphesoftCopilot\update.ps1
```

### What the updater does
1. Requires an existing install under `%LOCALAPPDATA%\EphesoftCopilot` (run `install.ps1` first if missing).
2. Downloads the latest `main` branch from GitHub.
3. Installs the extension into a fresh versioned `app-<timestamp>` folder (avoids file locks from a running browser).
4. Refreshes desktop shortcuts to point at the new folder.
5. Leaves `%LOCALAPPDATA%\EphesoftCopilot\profile` intact (login / license / API key survive).

### After updating
1. **Close** all Ephesoft Copilot browser windows (the dedicated-profile Chrome/Edge windows).
2. Relaunch via the desktop shortcut (`Ephesoft Copilot (Chrome)` or `(Edge)`).
3. Confirm the side panel still shows a valid license and the expected model/API key.

> Avoid `irm ... | iex` for the updater as well — use the download-then-run pattern above on corporate PowerShell.

---

## 4. Pre-Configuring Settings (Managed Storage Policy)

Push the Gemini API key and model so end-users see **"Managed by IT policy"** and cannot edit settings.

### Google Chrome
* Key: `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<extension_id>\policy`
* Values:
  * `geminiApiKey` (`REG_SZ`) — corporate Gemini key
  * `geminiModel` (`REG_SZ`) — e.g. `gemini-3.5-flash` (new keys) or `gemini-3.1-pro-preview`

### Microsoft Edge
* Key: `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\<extension_id>\policy`
* Same values as Chrome.

Schema reference: `extension/managed_schema.json`

After deploying policies, run `gpupdate /force` and verify at `chrome://policy` or `edge://policy`.

---

## 5. Offline Cryptographic Licensing

### How it works
1. Extension embeds an ECDSA P-256 **public key**.
2. You generate signed license keys locally with `scripts/generate_license.js`.
3. Extension verifies signature + expiration **100% offline** via Web Crypto.
4. No license server, no phone-home.

### Generate a client license
```bash
node scripts/generate_license.js --client "Client Name" --expires "YYYY-MM-DD"
```

Example:
```bash
node scripts/generate_license.js --client "Quadrantech Pilot" --expires "2099-12-31"
```

Send the Base64 output to the client. They paste it into **Settings → License Key → Save**.

### Developer bypass (internal testing only)
A non-guessable internal bypass key exists for developer QA. **Do not publish it in public docs.** Share only with trusted testers via direct message.

### Key management
* Private key lives in `keys/private.pem` (gitignored). **Back it up offline** — losing it invalidates all issued licenses.
* To rotate keys: generate a new keypair, update `PUBLIC_KEY_B64` in `extension/lib/license.js`, rebuild, and re-issue all client licenses.

### Build protection
Production builds obfuscate JavaScript via `node scripts/package_extension.js`. The 1-click installer runs this automatically when Node.js is present.

---

## 6. Private Self-Hosting (No Public Web Store)

When public store publishing is blocked:

1. **Package:** `node scripts/package_extension.js` → obfuscated zip
2. **CRX:** `chrome://extensions` → Pack extension → keep `.pem` key secure
3. **update.xml** on internal server:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='<your_extension_id>'>
    <updatecheck codebase='https://your-internal-server.corp/copilot/extension.crx' version='2.0.0' />
  </app>
</gupdate>
```

4. **GPO force-install** pointing to your update manifest:
   `<extension_id>;https://your-internal-server.corp/copilot/update.xml`

---

## 7. Network Allowlist

Ensure outbound HTTPS is permitted to:
* `https://generativelanguage.googleapis.com` (Gemini API)

Corporate TLS inspection may require adding Google's roots or an explicit allowlist entry (see your IT SSL troubleshooting notes from V1 pilot).

---

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| :--- | :--- | :--- |
| Extension not loading | Normal browser already open | Use desktop shortcut (dedicated profile) or GPO force-install |
| Update says no install found | Ran update.ps1 before install | Run `install.ps1` first, then use `update.ps1` for upgrades |
| Stale extension after update | Old browser window still open | Close all Copilot profile windows, then relaunch the desktop shortcut |
| "Disable developer mode extensions" banner | `--load-extension` on default profile | Switch to GPO force-install for production |
| License invalid | Wrong key, expired, or key rotation | Re-issue license; verify full Base64 pasted |
| Managed settings missing | GPO not applied | `gpupdate /force`, check `chrome://policy` |
| Fill less accurate in VM | Screenshot capture blocked | Normal — extension falls back to text-only; verify scroll/fill still completes |
| Gemini 403/SSL | Proxy or key permissions | Allowlist API domain; verify API key and model access |
| Model not found / "not offered to new customers" | Gemini 2.5 blocked for new AI Studio keys | Switch Settings model to `gemini-3.5-flash` or `gemini-3.1-pro-preview`, Save, Test key |

---

## 9. Building a Release Package

From the repo root (requires Node.js):

```bash
npm install
node scripts/generate_icons.js   # once, if icons missing
node scripts/package_extension.js
```

Output: `dist/ephesoft-copilot-extension-v2.0.0.zip` (obfuscated, ready to distribute).

Attach this zip to GitHub Releases for the installer to prefer over live repo builds.
