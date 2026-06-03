# Ephesoft Copilot SOP — Wombat / Independence Pet Group

Authoritative rules for extraction and fill planning. The human always validates in Ephesoft;
this agent never clicks Validate. When processing must stop, use **only** the three
`incomplete_reason` values in section 5.

---

## 1. Document type selection

| Document on screen | Set `doc_type` to |
|---|---|
| Standard vet/provider invoice | `invoice` |
| Pharmacy receipt / Rx slip | `pharmacy` |
| Estimate or draft invoice | `estimate` |
| Treatment plan | `invoice` |
| Open invoice (not yet paid) | `invoice` |
| Medical records / clinical notes | `medical_records` |
| Online provider order confirmation | `online_provider` |
| Petco / Vetco receipt | `invoice` — **NOT** `pharmacy` |
| Claim form only (no invoice) | `incomplete` → reason `Missing Invoice` |
| Payment slip only (no invoice) | `incomplete` → reason `Missing Invoice` |

Also supported types for classification reference: `claim_form` when a claim form is visible
alongside an invoice (see combined documents below).

### Edge cases

- **Claim form + invoice on one image**: `doc_type` = `invoice`. Extract and fill invoice
  fields only; ignore claim-form-only fields. Do **not** set `COMBINED_DOC` for this case.
- **Two separate invoices on one image**: add flag `COMBINED_DOC`, set
  `incomplete_reason` = `Missing Information` — human must split.
- **Estimate / quote / draft**: `doc_type` = `estimate`, flag `ESTIMATE` (fill may proceed;
  human reviews).
- **Line items do not match claim**: `incomplete_reason` = `Missing Information`.
- **Multi-pet invoice**: flag `MULTI_PET`. Use claim form page 1 to pick the claimed pet if
  visible; line items for that pet only. If unsure which pet → `incomplete_reason` =
  `Missing Information`.
- **Pet name on invoice differs from claim**: use pet name from the **invoice**; expected
  Ephesoft mismatch review.
- **Pharmacy, no medication name**: `pharmacy`; line description = exactly what is on the
  receipt (e.g. `RX 12345`).
- **Partially obstructed / blurry**: if line items and totals are legible, process normally.
  Only `Illegible Documents` when critical fields truly cannot be read.

---

## 2. Field rules

### Invoice date

- Numeric only: `MM/DD/YYYY` or `YYYY-MM-DD` (convert text dates, e.g. March 15, 2024 →
  `03/15/2024`).
- Prefer service/invoice date over due date or statement date.
- **If missing on document**: use today's date (UTC date when extracting).

### Invoice number (priority)

1. Invoice number  
2. Rx number (pharmacy)  
3. Order number (online provider)  
4. Reference / statement number  
5. Any other unique identifier  

If using Rx/order instead of invoice number → flag `NO_INVOICE_NUMBER`.

### Provider name

- Business/clinic name only — no street, phone, or website in this field.
- Keep suffixes like DVM, Veterinary, Animal Hospital, Clinic when part of the official name.

### Pet name

- Exactly as written on the invoice.
- Multiple pets → flag `MULTI_PET` (see edge cases).

### Amounts (`net_total`, `invoice_total`, line `unit_cost`)

- **invoice_total**: final amount due/paid including tax, shipping, fees.
- **net_total**: subtotal **before** tax (`invoice_total − sum(all taxes)`).
- If multiple tax lines: sum all taxes first, then subtract from invoice_total.
- Enter tax in the dedicated tax field separately; do not include tax in `net_total`.
- Strip all `$`, commas, and stray `S`/`5` used as dollar markers before values are returned.
- **Never** negative values in `net_total` or `invoice_total`.
- If tax is present, `net_total` must be **strictly less than** `invoice_total`; otherwise
  set `incomplete_reason` = `Missing Information` and flag `MISSING_INVOICE_TOTAL`.

Examples: invoice_total 123.98, tax 10.69 → net_total 113.29.

---

## 3. Line item table

### Include

- All line items with a **non-zero** charge.
- If qty absent → `qty` = `1`.
- "Regular fee" vs "your fee" columns → use **your fee** (amount owner paid).
- Discount **within** a line → enter discounted price.
- Negative amounts **in the subtotal** → include in table; flag `NEGATIVE_LINE_ITEMS`.

### Exclude

- $0 charge lines — do not return them in `line_items`.
- Post-subtotal discounts / payment credits (e.g. "Paid by Visa -$50") — not line items.

### Data quality

- Watch missing decimals (1500 vs 15.00).
- Two invoices as one document → `COMBINED_DOC` + stop (section 5).

---

## 4. Warning flags (do not stop fill unless section 5 applies)

Add to `flags` when true (human sees warnings on the panel):

| Flag | When |
|---|---|
| `ILLEGIBLE` | Critical sections unreadable (usually becomes incomplete — section 5) |
| `COMBINED_DOC` | Two invoices need splitting (must stop — section 5) |
| `MULTI_PET` | Multiple pets on invoice |
| `NEGATIVE_LINE_ITEMS` | In-subtotal discounts/credits in table |
| `NO_INVOICE_NUMBER` | Using Rx/order/reference instead of invoice # |
| `ESTIMATE` | Draft/quote/estimate document |
| `MISSING_INVOICE_TOTAL` | Total missing or net/total relationship invalid |

---

## 5. Incomplete — stop fill (three reasons only)

When the batch cannot be auto-filled, set `incomplete_reason` to **exactly one** of:

| `incomplete_reason` | Use when |
|---|---|
| `Missing Invoice` | No invoice — only claim form, payment slip, or empty |
| `Missing Information` | Invoice present but required fields unknown, COMBINED_DOC (two invoices), multi-pet unresolved, line/claim mismatch, invalid totals |
| `Illegible Documents` | Document completely unreadable |

Do **not** use any other incomplete reason string. Set `doc_type` to `incomplete` when stopping
for missing invoice; otherwise keep the best matching type and rely on `incomplete_reason`.

Also set `incomplete_reason` when flags imply stop: `COMBINED_DOC` (two invoices), unresolved
`MULTI_PET`, or `ILLEGIBLE` with no readable totals/line items.

---

## 6. Scenarios quick reference

| Scenario | Action |
|---|---|
| Treatment plan | `invoice`, fill normally |
| Open invoice | `invoice`, fill normally |
| Petco / Vetco | `invoice` |
| Claim + invoice combined | `invoice`, invoice fields only |
| Payment slip only | `incomplete`, `Missing Invoice` |
| Two invoices one file | `COMBINED_DOC`, `Missing Information` |
| Invoice date missing | today's date in `invoice_date` |
| Discount after subtotal | omit from `line_items` |
| Insured items to skip | omit those lines; fill the rest |
