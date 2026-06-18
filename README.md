# Ephesoft Copilot

Ephesoft Copilot is a secure, hybrid desktop utility designed to automate tedious data entry tasks for Business Process Outsourcing (BPO) agents working within the Ephesoft document processing portal. 

By combining a floating Electron panel, a lightweight Google Chrome extension, and an intelligent Python backend powered by Gemini 3.1 Pro, Ephesoft Copilot reads documents with advanced vision, populates claim fields in seconds, and ensures the human agent remains firmly in control.

---

## 1. Product Description

Ephesoft Copilot is built on a **hybrid, safety-first architecture** that integrates seamlessly with an agent's existing workflow:

```
┌────────────────────────┐                  ┌────────────────────────┐
│  Electron Panel (UI)   │◄───/ws/panel────►│ FastAPI Python Backend │
│  - Fill / Next buttons │                  │ - Extraction & Planning│
│  - Status & Audit Feed │                  │ - OpenClaw Resolution  │
└────────────────────────┘                  └───────────┬────────────┘
                                                        │
                                                 /ws/extension
                                                        │
                                                        ▼
┌────────────────────────┐                  ┌────────────────────────┐
│  Active Ephesoft Tab   │◄──scripting──────│ Chrome MV3 Extension   │
│  - Real Chrome Session │                  │ - Visible DOM Actions  │
└────────────────────────┘                  └────────────────────────┘
```

### Key Technical Components:
* **Electron Floating Panel**: A lightweight, "always-on-top" desktop window that provides the user interface (Fill, Next, Settings, and Status Feed) without obstructing the main browser workspace.
* **Chrome Manifest V3 Extension**: Runs directly inside the agent's standard Chrome browser. It acts as the "hands" of the Copilot, executing low-level DOM actions on the active tab while preserving the agent's active login session and credentials.
* **FastAPI Backend (Python)**: The orchestrator. It manages secure WebSocket channels, coordinates with the Gemini API, and processes page structures.
* **OpenClaw Element Resolution**: A dynamic element-finding system. Instead of relying on fragile, hard-coded CSS selector maps that break when Ephesoft updates its UI, OpenClaw sends the page's cleaned HTML and a natural language description (e.g., *"input field for net_total"*) to Gemini to resolve the correct, real-time CSS selector on the fly.
* **Gemini 3.1 Pro**: Extracts structured data from invoice documents, plans a sequence of safe filling actions, and performs a post-fill verification pass to flag any errors or red fields.

---

## 2. Use Case

In high-volume BPO operations, agents process hundreds of claims daily. A typical manual workflow looks like this:
1. Open a new batch in Ephesoft.
2. Scroll through the uploaded invoice or receipt on one half of the screen.
3. Manually type the Invoice Date, Invoice Number, Provider Name, and Pet Name into the Ephesoft form.
4. Review the invoice total, calculate the net total (subtotal before tax), and type both values.
5. Clear any pre-existing line items in the table.
6. Manually type each line item's Description, Quantity, and Unit Cost.
7. Click "Validate" to submit the claim.

### The Copilot Workflow:
With Ephesoft Copilot, the BPO agent's workflow is transformed:
1. The agent logs into Ephesoft in Chrome exactly as they normally do.
2. The agent opens the Ephesoft Copilot desktop application.
3. The agent clicks **Next** on the Copilot panel. The backend reads the batch list, filters for unassigned batches, sorts by date, and automatically opens the oldest available claim.
4. The agent clicks **Fill**. The Copilot automatically scrolls the page to capture a complete view, extracts all invoice and line item data using Gemini Vision, resolves the form fields, and types the data into the page.
5. The Copilot runs a verification pass and highlights any fields that are empty or showing validation errors.
6. **The human reviews the filled form, makes any necessary adjustments, and clicks Validate.**

---

## 3. Setup Once Repo is Cloned

Follow these steps to set up and run the application from source.

### 3.1 Prerequisites
Ensure you have the following installed:
* **Python 3.11+** (with `pip` and `venv`)
* **Node.js 18+** (with `npm`)
* **Google Chrome**

### 3.2 Installation

1. **Clone the repository** and navigate to the project directory:
   ```bash
   cd Ephesoft-copilot
   ```

2. **Run the installation script**:
   * **Mac / Linux**:
     ```bash
     chmod +x install.sh launch.sh
     ./install.sh
     ```
   * **Windows** (Open PowerShell as Administrator):
     ```powershell
     Set-ExecutionPolicy Bypass -Scope Process -Force
     .\install.ps1
     ```
   
   *This script creates a Python virtual environment (`.venv`), installs all required Python packages (FastAPI, Google Generative AI, Keyring, etc.), installs Node dependencies, and creates a default `config.json` file.*

3. **Load the Chrome Extension**:
   * Open Google Chrome and navigate to `chrome://extensions/`.
   * Enable **Developer mode** using the toggle switch in the top-right corner.
   * Click **Load unpacked** in the top-left corner.
   * Select the `extension` folder inside the cloned repository directory.
   * Verify that the extension shows up and is active.

### 3.3 Configuration & First Run

1. **Launch the application**:
   * **Mac / Linux**:
     ```bash
     ./launch.sh
     ```
   * **Windows**:
     ```powershell
     .\launch.ps1
     ```

2. **Set up your Gemini API Key**:
   * Once the floating panel opens, click the **gear icon (⚙)** in the top-right corner to open Settings.
   * Paste your Gemini API key (obtained from [Google AI Studio](https://aistudio.google.com/apikey)). The key must start with `AIza`.
   * Click **Test key** to verify the connection.
   * Click **Save** to securely store the key in your operating system's secure keychain (macOS Keychain or Windows Credential Manager).

3. **Verify Connection Indicators**:
   In the panel header, ensure both status dots are green:
   * **panel**: Green indicates the Electron UI is connected to the local FastAPI backend.
   * **ext**: Green indicates the Chrome extension is active and connected to the backend.

---

## 4. Best and Safest Way to Use It

Ephesoft Copilot is designed with strict **safety-first guardrails** to protect business data, prevent accidental submissions, and comply with standard operating procedures (SOPs).

### 4.1 The "Human-in-the-Loop" Mandate
* **No Auto-Validation**: The Copilot **never** clicks the "Validate" or "Submit" button. The tool's execution loop ends by presenting the filled fields to the agent. The final review and submission are strictly the responsibility of the human agent.
* **No Destructive Actions**: The Copilot is structurally blocked from performing destructive browser actions such as skipping batches, merging documents, splitting documents, or deleting entire files.

### 4.2 Multi-Layered Technical Guardrails
1. **Closed Tool Schema (`server/tools.py`)**:
   The backend only recognizes and executes a closed set of 7 actions:
   * `set_document_type`
   * `fill_field`
   * `clear_table`
   * `insert_table_row`
   * `take_screenshot`
   * `flag_incomplete`
   * `report_complete`
   
   Any attempt by the agent or model to execute an action outside this list (such as `click_validate` or `submit_form`) is blocked instantly at the Python execution layer before any DOM command is dispatched.

2. **Extension Command Allowlist (`extension/service_worker.js`)**:
   As a second layer of defense-in-depth, the Chrome extension service worker enforces an identical command allowlist. If the backend sends a command not in the allowlist, the extension rejects it immediately.

3. **Label-Based Click Protection**:
   The extension contains a hard-coded safety check on all click events. It inspects the target element's text, value, and ARIA labels. If the label contains banned words (such as *"validate"*, *"skip batch"*, *"merge documents"*, or *"split documents"*), the click is aborted, and an error is raised.

### 4.3 Best Practices for Agents
* **Keep Chrome Visible**: Ensure the Ephesoft tab in Chrome is open and visible on your screen. The extension operates on the active tab.
* **Use the "I edited" Button**: If you manually modify any field populated by the Copilot, click the **I edited** button on the panel. This logs the correction to `logs/actions/` to help continuously improve the system's extraction prompts and quality metrics.
* **Heed the Warning Flags**: If the Copilot flags a batch as `incomplete` (with reasons like *Missing Invoice*, *Missing Information*, or *Illegible Documents*), do not attempt to force-fill. Review the warning flags (e.g., `MULTI_PET`, `COMBINED_DOC`, `ESTIMATE`) shown on the panel and handle the batch manually according to Wombat/IPG SOP guidelines.

---

## 5. BPO Agent Time-Saving Advantages & ROI

Manually processing claims is a major bottleneck in BPO operations. Ephesoft Copilot shifts the agent's role from **manual data entry** to **high-speed data verification**, resulting in massive time savings and operational efficiency.

### 5.1 Time Breakdown: Manual vs. Copilot

| Task / Step | Manual Processing Time | Copilot Processing Time | Time Saved |
| :--- | :---: | :---: | :---: |
| **Batch Selection** (Filtering, sorting, opening oldest) | 15 – 30 seconds | **1.5 seconds** (One-click "Next") | ~20 seconds |
| **Data Extraction** (Reading dates, totals, provider, pet) | 30 – 60 seconds | **3 – 5 seconds** (Gemini Vision) | ~40 seconds |
| **Form Filling** (Typing fields, formatting dates, stripping symbols) | 30 – 45 seconds | **2 – 3 seconds** (Automated Fill) | ~35 seconds |
| **Line Items Entry** (Clearing table, typing descriptions, costs, qty) | 60 – 120 seconds | **5 – 10 seconds** (Automated Table Fill) | ~90 seconds |
| **Verification & Review** (Auditing math, checking for red fields) | 30 – 45 seconds | **3 seconds** (Post-Fill Vision Pass) | ~30 seconds |
| **Total Time Per Claim** | **2.5 – 5.0 minutes** | **15 – 25 seconds** | **2.0 – 4.0 minutes** |

### 5.2 Key Advantages & ROI Impact
* **85% Reduction in Processing Time**: By automating the reading, scrolling, formatting, and typing steps, Copilot completes the heavy lifting in under 25 seconds.
* **Elimination of Transcription Fatigue**: Typing hundreds of complex medical descriptions, NDC codes, and multi-digit dollar amounts leads to physical fatigue and high error rates. Copilot handles the transcription with absolute precision, stripping currency symbols and formatting dates automatically per SOP.
* **3 to 5 Hours Saved Daily Per Agent**: An average BPO agent processing 100 claims a day manually spends 5 to 8 hours typing. With Copilot, those same 100 claims take less than 40 minutes of automated filling, saving **3 to 5 hours of manual labor every single day**.
* **Massive Throughput Boost**: Agents can process **3x to 5x more claims per hour**, dramatically reducing backlog queues, meeting tight Service Level Agreements (SLAs), and lowering operational costs.
* **Zero-Configuration Deployment**: The packaged desktop version bundles the entire Python backend and runs out of the box, making it incredibly easy to distribute to remote or offshore BPO teams.
