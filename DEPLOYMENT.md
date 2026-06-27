# Ephesoft Copilot - Enterprise Deployment & IT Administration Guide

This guide provides system administrators and IT departments with instructions to deploy, configure, and manage the **Ephesoft Copilot** extension across enterprise fleets. It covers both **Google Chrome** and **Microsoft Edge** on Windows environments.

---

## 1. Architecture & Security Overview

Ephesoft Copilot (V2) is a **pure Chrome/Edge extension** (Manifest V3). 
* **No Local Backend**: It does not run local servers, Python environments, or background executable processes.
* **Network Security**: It communicates directly with the Google Gemini API via standard HTTPS requests (`https://generativelanguage.googleapis.com/*`).
* **Data Privacy**: No document data, screenshots, or credentials are sent to any third-party servers other than the configured Gemini API endpoint.
* **Storage**: Settings (API keys) are stored securely using the browser's sandboxed storage (`chrome.storage.local` or `chrome.storage.managed`).
* **Offline Cryptographic Licensing**: To safeguard Intellectual Property and control client access, the extension utilizes a 100% offline asymmetric cryptographic license verification system. It locks the extension to specific expiration dates without making any external cloud API calls.

---

## 2. Pilot & Developer Deployment (1-Click Installer)

For pilot programs, developers, or quick local trials, we provide a **1-click PowerShell bootstrap installer** that does not require local administrator privileges or modifications to system-wide execution policies.

### The 1-Line Installer Command
Open a standard Windows PowerShell window (no admin rights needed) and paste the following command:

```powershell
irm -useb https://raw.githubusercontent.com/vedaankb/Ephesoft-copilot/main/install.ps1 | iex
```

### What the Installer Does:
1. **Downloads**: Downloads the latest packaged extension zip directly from GitHub.
2. **Installs**: Extracts the extension files to the user's sandboxed local directory: `%LOCALAPPDATA%\EphesoftCopilot`.
3. **Shortcuts**: Auto-detects Google Chrome and Microsoft Edge installations and generates custom Desktop Shortcuts:
   * `Ephesoft Copilot (Chrome)`
   * `Ephesoft Copilot (Edge)`
4. **Launches**: The shortcuts launch Chrome or Edge with the `--load-extension` flag pre-configured, loading the extension instantly into the browser session.

---

## 3. Enterprise Fleet Deployment (Group Policy / GPO)

For large-scale production rollouts, IT departments can force-install the extension and lock down configurations using Active Directory Group Policy Objects (GPO) or Registry keys.

### Step 3.1: Force-Install the Extension
You can force-install the extension from the Chrome Web Store or Edge Add-ons Store so that it is automatically added to all users' browsers, cannot be disabled or uninstalled by the user, and receives automatic updates.

#### For Google Chrome:
1. Open your Group Policy Management Editor and navigate to:
   `Computer Configuration \ Administrative Templates \ Google \ Google Chrome \ Extensions`
2. Open the **Configure the list of force-installed apps and extensions** policy.
3. Enable the policy and click **Show...**.
4. Add the following value (replace `<extension_id>` with your published extension ID):
   ```text
   <extension_id>;https://clients2.google.com/service/update2/crx
   ```

*Alternatively, via Registry:*
* **Path**: `HKLM\Software\Policies\Google\Chrome\ExtensionInstallForcelist`
* **Name**: `1` (or next sequential index)
* **Type**: `REG_SZ`
* **Value**: `<extension_id>;https://clients2.google.com/service/update2/crx`

#### For Microsoft Edge:
1. Open your Group Policy Management Editor and navigate to:
   `Computer Configuration \ Administrative Templates \ Microsoft Edge \ Extensions`
2. Open the **Control which extensions are installed silently** policy.
3. Enable the policy and click **Show...**.
4. Add the following value (replace `<extension_id>` with your published extension ID):
   ```text
   <extension_id>;https://edge.microsoft.com/extension/update/chrome/v5
   ```

*Alternatively, via Registry:*
* **Path**: `HKLM\Software\Policies\Microsoft\Edge\ExtensionInstallForcelist`
* **Name**: `1` (or next sequential index)
* **Type**: `REG_SZ`
* **Value**: `<extension_id>;https://edge.microsoft.com/extension/update/chrome/v5`

---

## 4. Pre-Configuring Settings (Managed Storage Policy)

To make the extension **zero-configuration** for end-users, IT administrators can pre-configure the Gemini API key and model. When these policies are pushed, the extension's Settings panel will display **"Managed by IT policy"** and lock the input fields to prevent tampering.

### Step 4.1: Registry Configuration

Create the following registry keys and values to configure the extension settings.

#### For Google Chrome:
* **Key Path**: `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<extension_id>\policy`
* **Values**:
  * `geminiApiKey` (Type: `REG_SZ`): Your corporate Gemini API key (starts with `AIza`).
  * `geminiModel` (Type: `REG_SZ`): The model to use (e.g., `gemini-2.5-pro` or `gemini-2.5-flash`).

#### For Microsoft Edge:
* **Key Path**: `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\<extension_id>\policy`
* **Values**:
  * `geminiApiKey` (Type: `REG_SZ`): Your corporate Gemini API key (starts with `AIza`).
  * `geminiModel` (Type: `REG_SZ`): The model to use (e.g., `gemini-2.5-pro` or `gemini-2.5-flash`).

### Step 4.2: ADMX Group Policy Templates (Alternative)

If using ADMX templates, you can configure these settings under the **Extension 3rd Party Policies** section by providing the policy schema defined in `extension/managed_schema.json`:

```json
{
  "geminiApiKey": "AIzaSyYourCorporateKeyHere...",
  "geminiModel": "gemini-2.5-pro"
}
```

---

## 5. Offline Cryptographic Licensing (IP Protection)

To safeguard your Intellectual Property and prevent clients from distributing or using the extension without authorization, the extension enforces a **100% Offline Cryptographic Licensing** mechanism.

### How it Works:
1. **Asymmetric Cryptography**: The extension embeds an asymmetric **ECDSA (P-256)** public key. Only you (the creator) possess the secret private key.
2. **Signed License Keys**: When onboarding a client, you generate a cryptographically signed license key containing their name and expiration date.
3. **Offline Verification**: The extension verifies the license key's signature using the embedded public key natively via the browser's Web Crypto API. This is 100% offline and requires no cloud database or licensing server.
4. **Access Enforcement**: The service worker and sidepanel enforce:
   * **Expiration Lock**: The extension will block execution if the current system date is past the `expires` date.
5. **Backdoor Master Key**: For developer testing or emergency bypasses, entering the literal string `1` as the license key acts as an override, granting unlimited access with a mock developer profile.

### How to Generate a License Key for a Client:
Run the license generator script on your development machine:

```bash
node scripts/generate_license.js --client "Client Name" --expires "YYYY-MM-DD"
```

**Example**:
```bash
node scripts/generate_license.js --client "Wombat BPO" --expires "2027-06-30"
```

Copy the generated Base64 block and send it to your client. They must paste it into the **License Key** field in the Settings panel of the Copilot to activate the extension.

---

## 6. Private Self-Hosting (Alternative to Web Stores)

If your corporate policy prohibits publishing to public web stores (even as unlisted), you can host the extension on an internal IIS, Apache, or Nginx web server.

### Step 6.1: Package the Extension
1. Package the extension into a `.crx` file using Chrome's built-in packager:
   `chrome://extensions > Pack extension > select the "extension" folder`.
2. This generates a `.crx` file and a `.pem` private key file. Keep the `.pem` file secure to sign future updates.

### Step 6.2: Create the Update Manifest (`update.xml`)
Host an XML file on your internal server alongside the `.crx` file:

```xml
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='<your_extension_id>'>
    <updatecheck codebase='https://your-internal-server.corp/copilot/extension.crx' version='2.0.0' />
  </app>
</gupdate>
```

### Step 6.3: Deploy via GPO
When force-installing the extension (Section 3), point the GPO/Registry to your internal update manifest instead of the public store:

```text
<your_extension_id>;https://your-internal-server.corp/copilot/update.xml
```

---

## 7. Troubleshooting & Support

* **Extension not loading**: Verify that Developer Mode is allowed by GPO on pilot machines, or use the GPO Force-Install method.
* **Network / Proxy Blocks**: Ensure that your corporate proxy allows outbound HTTPS requests to:
  `https://generativelanguage.googleapis.com`
* **Managed Settings not appearing**: Run `gpupdate /force` in a command prompt to force-apply Group Policies, then check `chrome://policy` or `edge://policy` to verify that the policies are active.
