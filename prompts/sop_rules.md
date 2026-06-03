# Standard Operating Procedure (SOP) Rules for Ephesoft Document Processing

These rules govern how all document fields, line items, and document types must be parsed, validated, and processed. These rules are non-negotiable and must be strictly adhered to by the extraction engine.

## 1. Document Classification Rules

Every document must be classified into one of the following six categories:
- **invoice**: Itemized list of services/products, dollar amounts per line, provider letterhead, subtotal, tax, and total.
- **pharmacy**: Prescription (Rx) number, NDC codes, drug names, dispensing pharmacy header, dosage info.
- **estimate**: "Estimate", "Quote", "Draft", or "Proposed" text. Quoted/estimated costs rather than final billed amounts.
- **medical_records**: Clinical notes, SOAP notes, diagnosis codes (ICD), physician/veterinarian signature, clinical observations. Minimal or no billing information.
- **claim_form**: Pre-printed insurance claim form layout (e.g., IPG/Hartville), policy number field, claimant details.
- **online_provider**: Online pharmacy or retailer order confirmation (e.g., Chewy, Amazon Pet), order number, ship-to address, digital receipt layout.

---

## 2. Field-Level Parsing and Validation Rules

### 2.1 Invoice Date
- **Format**: Must be numeric format only (MM/DD/YYYY or YYYY-MM-DD).
- **Text Conversion**: Convert text dates to numeric. E.g., "March 15, 2024" must be converted to "03/15/2024" or "2024-03-15".
- **Selection**: If multiple dates are present, prefer the invoice/service date over the payment due date or statement date.

### 2.2 Invoice Number
- **Priority Order**:
  1. Invoice Number (if explicitly present)
  2. Rx Number (for pharmacy receipts)
  3. Order Number (for online provider receipts)
  4. Reference Number or Statement Number
  5. Any other unique identifier on the document
- **No Invoice Number**: If no invoice number is found and an alternative (Rx/Order) is used, the extraction must be flagged with `NO_INVOICE_NUMBER`.
- **Missing entirely**: If absolutely no unique number is present, flag with `MISSING_INVOICE_TOTAL` or `NO_INVOICE_NUMBER` as appropriate.

### 2.3 Provider Name
- **Extraction**: Extract the full business/clinic/hospital name.
- **Exclusions**: Do NOT include the street address, phone number, or website in the provider name field.
- **Inclusions**: Retain suffixes like "DVM", "Veterinary", "Animal Hospital", "Clinic" if they are part of the official business name.

### 2.4 Pet Name
- **Extraction**: Extract the pet/patient name exactly as written.
- **Multiple Pets**: If multiple pets are listed on the same document, flag with `MULTI_PET`. The human must decide how to split the charges.

### 2.5 Net Total and Invoice Total
- **Definitions**:
  - **invoice_total**: The final, absolute amount due/paid including all taxes, shipping, and fees.
  - **net_total**: The subtotal/amount BEFORE taxes are applied.
- **Formula**: `net_total = invoice_total - sum(all_taxes)`
- **Validation**: `net_total` MUST be strictly less than `invoice_total` if taxes are present. If `net_total` is calculated or extracted as greater than or equal to `invoice_total`, flag the document and stop processing.
- **Formatting**: Strip all currency symbols (`$`) and commas (`,`) from both net_total and invoice_total before writing. E.g., "$1,127.50" becomes "1127.50".

---

## 3. Line Items and Tables

- **Extraction**: Extract every line item with its description, quantity (qty), and unit cost.
- **Formatting**: Unit cost must have currency symbols and commas stripped.
- **Negative Line Items**:
  - Include negative line items (discounts, credits, coupons) in the table if they are part of the subtotal calculation.
  - Exclude post-subtotal discounts or payment credits (e.g., "Paid by Visa -$50.00").
  - If negative line items are present, flag with `NEGATIVE_LINE_ITEMS`.

---

## 4. Safety and Flags (When to Stop or Warn)

If any of the following conditions are met, the extraction must be flagged, and the panel must display a warning to the human:

- **ILLEGIBLE**: The document or any critical section (dates, totals, line items) is blurry, cut off, or unreadable.
- **COMBINED_DOC**: A claim form and an invoice/receipt are merged into a single image or document.
- **MULTI_PET**: More than one pet name is found on the invoice.
- **NEGATIVE_LINE_ITEMS**: Discounts or credits are present in the line items.
- **NO_INVOICE_NUMBER**: No traditional invoice number was found, and an Rx/Order number is being used instead.
- **ESTIMATE**: The document is a draft, quote, or estimate, not a final invoice.
- **MISSING_INVOICE_TOTAL**: The final invoice total cannot be found or is missing from the document.
