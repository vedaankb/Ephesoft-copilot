# Ephesoft Copilot

Floating desktop tool that automates data entry in Ephesoft. Human always validates — tool never clicks Validate.

## Features

- **Fill**: AI reads document and fills all fields using vision + browser automation
- **Next**: Parse batch list, open oldest unassigned batch
- **Safety-first**: Validate button is structurally blocked, closed tool schema
- **Mock mode**: Develop against local fixtures without live portal access

## Quick Start

### 1. Install dependencies

```bash
# Python dependencies
pip install -r requirements.txt
playwright install chromium

# Node dependencies
npm install
```

### 2. Configure

Copy example config and add your API keys:

```bash
cp config.example.json config.json
# Edit config.json with your Gemini API key and Ephesoft URL
```

For production, credentials are stored in OS keychain via:

```bash
python setup.py
```

### 3. Run

```bash
python run.py
```

This starts the FastAPI server and launches the Electron panel.

## Architecture

- **Backend**: FastAPI + WebSocket for real-time status updates
- **Browser**: Playwright persistent context (survives restarts)
- **Vision**: Gemini 1.5 Pro Vision for document extraction
- **Element resolution**: OpenClaw fallback when selectors fail
- **Frontend**: Electron + React panel (always-on-top, 380x600)

## Safety Guarantees

1. **Validate is structurally blocked** - not in tool schema, cannot be called
2. **Closed tool set** - only `set_document_type`, `fill_field`, `insert_table_row`, `clear_table`, `take_screenshot`, `flag_incomplete`, `report_complete`
3. **No generic actions** - no `click`, `navigate`, `type_arbitrary`, `submit`
4. **Verification mandatory** - agent screenshots and checks for red fields before reporting complete
5. **Append-only audit log** - every action logged with timestamp, never modified

## Mock Mode

Set `"MOCK": true` in `config.json` to develop against local fixtures:

```bash
# Capture Ephesoft page with a batch open
# Chrome → right-click → Save As → Webpage, Complete
# Save to fixtures/field_view.html
```

All agent logic, Gemini calls, and tool execution run identically — only browser target changes.

## Logs

- `logs/actions/YYYY-MM-DD_HH-MM-SS.json` - action log per session
- `logs/screenshots/before_*.png`, `after_*.png` - screenshots per batch
- Logs are gitignored

## Document Types

- invoice
- pharmacy
- estimate
- medical_records
- claim_form
- online_provider

Classification and field extraction rules in `prompts/doc_types.md`.

## Development

See `SPEC.md` for full implementation details and phase breakdown.
