# Ephesoft Copilot — Build Spec

## What This Is
Floating desktop tool (Electron + Python) that rides alongside Ephesoft. Human still validates — tool never clicks Validate. Two buttons: **Fill** (LLM reads doc, fills all fields via Playwright+OpenClaw) and **Next** (parse batch list, open oldest non-taken batch).

## Stack
- **Backend**: Python 3.11+, FastAPI, WebSocket
- **Browser automation**: Playwright (Python), persistent chromium context
- **Element resolution**: OpenClaw (fallback when selectors fail)
- **Vision + reasoning**: Gemini 2.5 Pro API
- **Frontend**: Electron + React (renderer), IPC bridge via preload.js
- **Logging**: JSON action logs + PNG screenshots per session (local only, gitignored)
- **Config**: OS keychain (Windows Credential Manager / macOS Keychain) via `keyring` lib

## Repo Structure
```
ephesoft-copilot/
├── README.md
├── .gitignore
├── config.example.json        # keys with empty values — commit this
├── requirements.txt
├── package.json               # electron deps
├── setup.py                   # first-run wizard: API key, keychain, fixture capture
├── run.py                     # starts FastAPI server, then electron
├── server/
│   ├── main.py                # FastAPI app, /ws WebSocket endpoint
│   ├── agent.py               # fill loop, next loop, tool dispatch
│   ├── tools.py               # action schema — ONLY callable actions
│   ├── browser.py             # playwright session, screenshot, MOCK flag
│   ├── openclaw_client.py     # element resolution wrapper
│   └── gemini_client.py       # vision extraction + action planning + verify
├── prompts/
│   ├── system.md              # agent instructions, tool list, hard constraints
│   └── doc_types.md           # per-type classification rules
├── electron/
│   ├── main.js                # main process, spawns FastAPI, BrowserWindow
│   ├── preload.js             # contextBridge IPC
│   └── renderer/
│       ├── index.html
│       ├── app.jsx            # Fill btn, Next btn, status feed, doc type badge
│       └── styles.css
├── fixtures/
│   ├── field_view.html        # saved Ephesoft field view for mock dev
│   ├── batch_list.html        # saved batch list page for mock dev
│   └── sample_docs/           # sample PDFs for testing (gitignored if sensitive)
└── logs/                      # gitignored
    ├── actions/               # YYYY-MM-DD_HH-MM-SS.json per session
    └── screenshots/           # before_<id>.png, after_<id>.png
```

## Config Schema (config.example.json)
```json
{
  "GEMINI_API_KEY": "",
  "EPHESOFT_URL": "",
  "MOCK": false,
  "LOG_SCREENSHOTS": true,
  "LOG_ACTIONS": true,
  "OPENCLAW_FALLBACK": true,
  "MAX_RETRIES": 2
}
```
Real config.json is gitignored. Credentials go to OS keychain, not config.json.

---

## Safety Rules — NON-NEGOTIABLE

### 1. Validate is structurally blocked
```python
# tools.py
BLOCKED_ACTIONS = ["validate", "skip_batch", "merge_documents", "split_documents"]

async def execute(action, element):
    if action.name in BLOCKED_ACTIONS:
        log_warning(f"BLOCKED: agent attempted {action.name}")
        raise BlockedActionError(f"{action.name} is not in tool schema")
```
Validate is not in TOOLS list. It cannot be called even if LLM hallucinates it.

### 2. Tool schema is closed — no generic click/navigate
```python
TOOLS = [
    "set_document_type",   # dropdown selection only
    "fill_field",          # named field write only
    "clear_table",         # delete all existing rows
    "insert_table_row",    # add one line item
    "take_screenshot",     # for mid-fill verify
    "flag_incomplete",     # sends warning to panel, stops fill
    "report_complete",     # signals human: ready to review
]
# No: click, navigate, type_arbitrary, submit, keyboard_shortcut
```

### 3. Agent never acts without screenshot context
Every action sequence is preceded by a screenshot. Agent cannot plan blind.

### 4. Verification pass is mandatory
After all fills complete, agent takes a second screenshot and checks for remaining red fields before calling report_complete. If red fields remain, they are listed in the panel.

### 5. Human always submits Validate in Ephesoft directly
Tool never touches the Validate button, the Skip button, the merge/split tools, or any navigation outside the current batch.

### 6. No credentials in repo, ever
Gemini API key and portal credentials stored in OS keychain via `keyring`. Read at runtime, never written to disk outside keychain. `.gitignore` covers: `config.json`, `.env`, `browser-data/`, `*.session`, `logs/`.

### 7. Action log is append-only
Every executed action is logged with timestamp, action name, field target, and whether it succeeded. Never modified after write. This is the audit trail.

---

## Agent Flow

### Fill
```
1. WebSocket message: {type: "fill"}
2. browser.screenshot() → base64 PNG
3. fetch doc URL(s) from current Ephesoft batch page
4. gemini_client.extract(screenshot, doc_bytes) →
   {doc_type, fields{}, line_items[], tax, flags[], confidence}
5. ws_update → "Detected: {doc_type} ({confidence}%)"
6. gemini_client.plan_actions(extraction) → actions[]
7. for action in actions:
     element = openclaw.resolve(action.element_description)
     tools.execute(action, element)
     log_action(action)
     ws_update → action.status_message
     await asyncio.sleep(0.3)
8. post_screenshot = browser.screenshot()
9. gemini_client.verify(post_screenshot) → {red_fields[], ok}
10. ws_update → {status:"complete", red_fields, flags, doc_type}
```

### Next
```
1. WebSocket message: {type: "next"}
2. Navigate to batch list view
3. Parse all visible batches → [{id, created_at, status, assigned_to}]
4. Filter: status != "in_progress" AND assigned_to == null
5. Sort by created_at ASC (oldest first)
6. Click top result → opens batch
7. ws_update → {status:"opened", batch_id, created_at}
```

---

## Gemini Response Schema

### Extraction call
```json
{
  "doc_type": "invoice|pharmacy|estimate|medical_records|claim_form|online_provider",
  "confidence": 94,
  "fields": {
    "invoice_date": "2024-03-15",
    "invoice_number": "INV-00342",
    "provider_name": "City Vet Clinic",
    "pet_name": "Max",
    "net_total": "117.29",
    "invoice_total": "127.98"
  },
  "line_items": [
    {"description": "Exam fee", "qty": "1", "unit_cost": "65.00"},
    {"description": "Amoxicillin 500mg", "qty": "14", "unit_cost": "3.75"}
  ],
  "tax": {"present": true, "amount": "10.69", "items": ["HST 10.69"]},
  "flags": [],
  "incomplete_reason": null
}
```

### Flags (any of these → panel warning, human decides)
```
ILLEGIBLE              - doc or section unreadable
COMBINED_DOC           - claim form and invoice merged as one image
MULTI_PET              - multiple pet names on invoice
NEGATIVE_LINE_ITEMS    - discounts/credits present (include in table)
NO_INVOICE_NUMBER      - use Rx or order number instead
ESTIMATE               - draft/estimate not a final invoice
MISSING_INVOICE_TOTAL  - mark incomplete
```

### Verify call response
```json
{
  "ok": true,
  "red_fields": [],
  "notes": "All fields accepted"
}
```

---

## Document Types + Classification Rules

Stored in `prompts/doc_types.md`, injected into every Gemini call.

| Type | Key visual signals |
|---|---|
| invoice | itemised service list, dollar amounts per line, provider letterhead |
| pharmacy | Rx number, NDC code, drug names, dispensing pharmacy header |
| estimate | "estimate"/"draft"/"quote" text, quoted not billed amounts |
| medical_records | clinical notes, diagnosis codes, ICD codes, physician signature |
| claim_form | IPG/Hartville form layout, policy number, pet name field |
| online_provider | online pharmacy/retailer order confirmation, order number |

Field-level rules:
- `net_total` = invoice total MINUS all taxes
- `invoice_total` = amount before tax subtraction  
- Negative line items: include in table if part of subtotal, exclude if post-subtotal discount
- No `$` signs, no commas in amounts
- Dates must be numeric (MM/DD/YYYY or YYYY-MM-DD)
- If no invoice number: use Rx number → order number → any unique number on doc

---

## Ephesoft Field Mapping

Populate during fixture capture (setup.py). Stored in `config.json` under `field_selectors`.

Required fields:
```
invoice_date, invoice_number, provider_name, pet_name,
net_total, invoice_total, document_type_dropdown,
table_insert_row_btn, table_delete_all_btn,
table_row_description, table_row_qty, table_row_unit_cost
```

OpenClaw fallback descriptions (used when selector fails):
```python
OPENCLAW_DESCRIPTIONS = {
    "invoice_date":         "date field labeled invoice date or service date",
    "invoice_number":       "text field for invoice number or reference number",
    "net_total":            "numeric field for net total or subtotal before tax",
    "invoice_total":        "numeric field for invoice total or amount due",
    "table_insert_row_btn": "button to add or insert a new line item row",
    "table_delete_all_btn": "button to delete all rows or clear table",
}
```

---

## Electron — Main Process Responsibilities
- Spawn FastAPI server as child process on app start
- Kill server on app close
- Single BrowserWindow: 380x600, always-on-top, no frame optional
- IPC: renderer → main → WebSocket → FastAPI
- No nodeIntegration, use contextBridge in preload.js

## Panel UI — React Renderer
States: IDLE → FILLING → COMPLETE → ERROR

Display per state:
- IDLE: Fill button, Next button, last batch info
- FILLING: spinner, live status feed (each agent step), progress indicator
- COMPLETE: doc type badge (color-coded), field summary, red fields list (if any), flags (if any), "I edited" button
- ERROR: error message, retry button

"I edited" button → logs `human_edit: true` for that batch in action log. This is the quality metric.

Doc type badge colors: invoice=blue, pharmacy=green, estimate=amber, medical_records=purple, incomplete=red

---

## Mock Mode

`MOCK: true` in config.json → Playwright targets `fixtures/field_view.html` instead of live Ephesoft.

`fixtures/field_view.html` must have identical field IDs/selectors as real Ephesoft. Capture with:
```bash
# On a machine with Ephesoft access, with a batch open:
# Chrome → right-click → Save As → Webpage, Complete
# Save to fixtures/field_view.html
```

All agent logic, Gemini calls, OpenClaw resolution, and tool execution run identically in mock mode. Only the browser target changes.

---

## Logging Schema

### Action log (logs/actions/YYYY-MM-DD_HH-MM-SS.json)
```json
{
  "session_id": "uuid",
  "batch_id": "EPH-00234",
  "doc_type": "invoice",
  "started_at": "2024-03-15T09:32:11Z",
  "actions": [
    {
      "seq": 1,
      "action": "set_document_type",
      "value": "invoice",
      "selector_used": "#docTypeDropdown",
      "openclaw_fallback": false,
      "success": true,
      "ts": "2024-03-15T09:32:13Z"
    }
  ],
  "completed_at": "2024-03-15T09:32:28Z",
  "red_fields_remaining": 0,
  "flags": [],
  "human_edit": false
}
```

### Screenshot naming
```
logs/screenshots/
  before_EPH-00234_20240315-093211.png
  after_EPH-00234_20240315-093228.png
```

---

## Implementation Order

### Phase 1 — Core infrastructure (Days 1-2)
- [ ] FastAPI server with `/ws` WebSocket endpoint
- [ ] Playwright browser session (persistent context, mock flag)
- [ ] Electron shell: main.js spawns server, preload.js IPC bridge
- [ ] React panel: Fill/Next buttons, WebSocket connection, status feed
- [ ] `tools.py`: full tool schema, BlockedActionError for BLOCKED_ACTIONS
- [ ] Action logger

### Phase 2 — Vision pipeline (Days 3-4)
- [ ] `gemini_client.py`: extraction call with system prompt + doc_types
- [ ] Parse Gemini JSON response, validate schema
- [ ] Tax subtraction logic
- [ ] Flag detection and panel warning display
- [ ] Test against 5 sample PDFs (invoice, pharmacy, estimate, combined, illegible)

### Phase 3 — Portal write (Days 5-6)
- [ ] `browser.py`: screenshot, fetch doc URL, read field selectors from config
- [ ] `openclaw_client.py`: element resolution with OPENCLAW_DESCRIPTIONS fallback
- [ ] Wire each tool to Playwright action
- [ ] Dynamic table row insertion (test: 1, 3, 8 line items)
- [ ] Verify pass: screenshot after fill, parse red field state
- [ ] End-to-end Fill in mock mode

### Phase 4 — Next button + batch logic (Day 7)
- [ ] Parse batch list HTML → extract id, created_at, status, assigned_to
- [ ] Filter + sort logic
- [ ] Playwright navigation to oldest open batch
- [ ] Panel update on batch open

### Phase 5 — On-site testing (Days 8-10)
- [ ] Capture real Ephesoft HTML into fixtures/
- [ ] Map real selectors into config
- [ ] Test Fill on live portal (start with clean invoices)
- [ ] Test Next on live batch list
- [ ] Verify OpenClaw fallback triggers correctly on any broken selectors
- [ ] Measure: time per batch, edit rate, doc type accuracy

---

## requirements.txt
```
fastapi
uvicorn[standard]
playwright
google-generativeai
keyring
python-dotenv
```

## package.json (key deps)
```json
{
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  }
}
```

---

## .gitignore
```
config.json
.env
browser-data/
*.session
logs/
__pycache__/
*.pyc
node_modules/
dist/
fixtures/sample_docs/
```

---

## Key Constraints for Cursor

1. `BLOCKED_ACTIONS` check in `tools.execute()` must run BEFORE any Playwright call
2. `report_complete` can only be called after `verify` pass runs
3. Gemini is called max 3 times per Fill: extract → (optional mid-fill) → verify
4. OpenClaw is called only when a mapped selector throws `ElementNotFound`
5. WebSocket sends a status update before and after every action (UI stays live)
6. `human_edit` flag in action log is set only by explicit panel button click, never inferred
7. All dollar signs and commas stripped from amounts before Playwright `.fill()` call
8. `net_total` must always be less than `invoice_total` — validate before writing, flag if not
