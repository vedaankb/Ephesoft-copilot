# Ephesoft Copilot

Floating Electron panel + Chrome extension that watches whatever Ephesoft (or
any document portal) page you're on, fills the fields with Gemini, and gets
out of the way. **The human always validates.**

## Architecture (one-liner)

```
Electron panel  ──/ws/panel──►  FastAPI ◄──/ws/extension──  Chrome MV3 extension
                                   │
                                   ├── Gemini 1.5 (extract / plan / verify)
                                   └── OpenClaw  (NL description → CSS selector
                                                  on whatever HTML is on the page)
```

Why both pieces:

- The **extension** runs inside your real Chrome session, so it can act on the
  Ephesoft tab you're already logged into. No second browser, no sandboxed
  Playwright window, no separate auth.
- The **Electron panel** is the human surface — Fill, Next, settings, status
  feed. It never touches the DOM directly; it sends intents to the backend,
  which routes a closed set of low-level commands to the extension.

## Safety, briefly

- **Closed tool schema** in `server/tools.py`: `set_document_type`, `fill_field`,
  `clear_table`, `insert_table_row`, `take_screenshot`, `flag_incomplete`,
  `report_complete`. Anything else is rejected before the DOM is touched.
- **Same closed allowlist** is enforced again inside the extension service
  worker, plus a label check that refuses to click anything labelled Validate
  / Skip / Merge / Split.
- The agent **never clicks Validate**. The human reviews what got filled and
  decides.

## Download package (for teammates)

Build a zip you can share (no `node_modules` / `.venv` — recipient runs install once):

```bash
chmod +x scripts/build_package.sh install.sh launch.sh
npm run build:package
```

Output: `dist/ephesoft-copilot-<version>-<os>-<date>.zip`

Recipient flow: unzip → `./install.sh` → load `extension/` in Chrome → `./launch.sh`  
Full steps in **INSTALL.md** (included in the zip).

## Install (dev / from source)

```bash
./install.sh
# or manually:
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
.venv/bin/python setup.py        # creates a default config.json
```

Load the extension once:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on
3. **Load unpacked** → pick the `extension/` folder

## Run

```bash
./launch.sh
# or: .venv/bin/python run.py
```

That spawns FastAPI on `127.0.0.1:8000` and opens the Electron panel.

In the panel:

1. Click the gear icon, paste your Gemini API key from
   <https://aistudio.google.com/apikey> (starts with `AIza`), click **Test
   key**, then **Save**. Keys are stored in your OS keychain.
2. The two header dots should both be green:
   - `panel` — Electron ↔ FastAPI
   - `ext`   — extension ↔ FastAPI
3. Open the Ephesoft tab you want to work on (or for testing, navigate Chrome
   to <http://127.0.0.1:8000/mock/batch_list>).
4. Click **Next** to open the oldest available batch, then **Fill**.

## Mock pages for end-to-end testing without real Ephesoft

- `http://127.0.0.1:8000/mock/batch_list` — a few synthetic batches with
  varying statuses and dates
- `http://127.0.0.1:8000/mock/field_view` — a stand-in field view for Fill

These intentionally do **not** match real Ephesoft markup pixel-for-pixel.
The point of OpenClaw is that the system works against whatever HTML is on
the page; the mocks are just enough to exercise the pipeline locally.

## Tests

```bash
.venv/bin/python -m unittest tests/test_tools_openclaw.py -v
```

Covers:
- Blocked actions raise immediately with **zero** DOM events emitted
- `fill_field` strips `$` and `,` from `net_total` / `invoice_total`
- `clear_table` + `insert_table_row` round-trip
- The extension channel itself rejects disallowed cmds before send

## Project structure

```
server/
  main.py               FastAPI: /ws/panel, /ws/extension, /api/settings, /mock/*
  extension_channel.py  Routes commands to the connected extension
  tools.py              Closed tool schema + safe execute()
  agent.py              fill_batch / open_next_batch loops
  gemini_client.py      Vision extraction, action planning, post-fill verify
  openclaw_client.py    NL description → CSS selector via Gemini
  credentials.py        API key loading (env / keychain / config.json)
  action_logger.py      Append-only per-batch audit log

extension/              Chrome MV3 extension (manifest, service worker, popup)

electron/               Electron main + renderer (React UI)
prompts/                system.md, sop_rules.md, doc_types.md
fixtures/               batch_list.html, field_view.html
tests/                  unit tests with FakeChannel + FakeOpenClaw
```

## SOP rules

`prompts/sop_rules.md` merges the Wombat / IPG SOP (Petco→invoice, three incomplete
reasons, line-item rules, claim+invoice handling, etc.) and is injected on every
Gemini extract/verify call. `server/sop.py` post-processes extractions in code:
amount sanitization, net/total check, $0 line drop, today's date default, and
normalizing `incomplete_reason` to `Missing Invoice` | `Missing Information` |
`Illegible Documents` only. Safety nets (no Validate, blocked tools) are unchanged.
