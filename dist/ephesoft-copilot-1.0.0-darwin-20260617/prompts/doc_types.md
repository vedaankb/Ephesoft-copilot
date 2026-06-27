# Document Type Classification Rules

Use these visual signals and field patterns to classify documents accurately.

## invoice

**Visual signals:**
- Itemized list of services or products
- Dollar amounts per line
- Provider/vendor letterhead or logo
- "Invoice" in header or title
- Subtotal, tax, and total sections
- "Amount Due" or "Balance"

**Field patterns:**
- invoice_date, invoice_number present
- Multiple line items with descriptions and costs
- Tax calculation visible
- Provider name/address prominent

**Examples:**
- Veterinary clinic invoice
- Hospital billing statement
- Vendor service invoice

---

## pharmacy

**Visual signals:**
- "Rx" or prescription number
- NDC (National Drug Code) numbers
- Drug/medication names
- "Pharmacy" or "Dispensed by" in header
- Dosage information (mg, ml, tablets)
- Dispensing date

**Field patterns:**
- Rx number (often starts with "Rx" or numeric)
- Drug names (generic or brand)
- Quantity dispensed
- Pharmacy name and address

**Special handling:**
- If no invoice number: use Rx number and flag NO_INVOICE_NUMBER

**Examples:**
- Retail pharmacy receipt
- Veterinary pharmacy dispensation
- Online pharmacy order

---

## estimate

**Visual signals:**
- "Estimate" or "Quote" in title
- "Draft" watermark
- "Estimated cost" language
- Future/proposed dates
- "Valid until" or expiration date

**Field patterns:**
- Tentative amounts (not final billing)
- Often says "estimate" explicitly
- May have conditional language

**Handling:**
- Extract all fields normally
- Flag with ESTIMATE
- Human decides if acceptable for claim

**Examples:**
- Veterinary treatment estimate
- Pre-approval quote
- Surgical estimate

---

## medical_records

**Visual signals:**
- Clinical notes or SOAP notes
- Diagnosis codes (ICD-10)
- Physician signature
- Medical terminology
- "Patient record" or "Medical notes"
- No dollar amounts or minimal billing

**Field patterns:**
- Patient/pet name
- Provider name (veterinarian, doctor)
- Dates of service/visits
- Diagnoses and treatments

**Handling:**
- Often lacks invoice number or amounts
- Extract what's available
- May flag MISSING_INVOICE_TOTAL

**Examples:**
- Veterinary exam notes
- Hospital discharge summary
- Lab results with clinical notes

---

## claim_form

**Visual signals:**
- Pre-printed form layout
- IPG or Hartville branding
- "Claim form" header
- Policy number field
- Checkboxes and structured fields
- Claimant signature section

**Field patterns:**
- Policy number
- Pet name and details
- Claim amount
- Often combined with invoice (flag COMBINED_DOC if so)

**Handling:**
- Focus on extracting invoice data if attached
- Flag COMBINED_DOC if claim form and invoice are one image

**Examples:**
- IPG pet insurance claim form
- Hartville claim submission

---

## online_provider

**Visual signals:**
- Online retailer layout (Chewy, Amazon, etc.)
- "Order confirmation" or "Order number"
- "Ship to" address
- Online pharmacy branding
- Digital receipt format

**Field patterns:**
- Order number instead of invoice number
- Item list (products ordered)
- Shipping and totals

**Special handling:**
- Use order number as invoice_number
- Flag NO_INVOICE_NUMBER
- Extract itemized products as line items

**Examples:**
- Chewy order confirmation
- Amazon pet supplies receipt
- 1-800-PetMeds order

---

## Field-Level Classification Rules

### Amounts

**net_total** (amount before tax):
- Look for: "Subtotal", "Net amount", "Amount before tax"
- Calculate: invoice_total - all_taxes
- Must be less than invoice_total

**invoice_total** (final amount due):
- Look for: "Total", "Amount due", "Balance", "Grand total"
- This is the final amount including tax

### Dates

- Convert all dates to numeric: MM/DD/YYYY or YYYY-MM-DD
- Look for: "Invoice date", "Service date", "Date of service", "Date"
- If multiple dates: prefer service/invoice date over payment due date

### Invoice Number

Priority order:
1. Invoice number (if present)
2. Rx number (pharmacy documents)
3. Order number (online providers)
4. Reference number
5. Any unique identifier

Flag NO_INVOICE_NUMBER if using alternative.

### Provider Name

- Extract full business name
- Include "DVM", "Veterinary", "Animal Hospital" if part of name
- Don't include address in provider name field

### Pet Name

- Extract exactly as written
- If multiple pets listed: flag MULTI_PET
- Common names: Max, Bella, Charlie, Luna, etc.

---

## Tax Handling

**Tax identification:**
- GST (Goods and Services Tax)
- HST (Harmonized Sales Tax)
- PST (Provincial Sales Tax)
- Sales Tax
- State Tax

**Calculation:**
```
net_total = invoice_total - sum(all_taxes)
```

**Negative line items:**
- Include discounts/credits in line items if part of subtotal calculation
- Don't include post-subtotal promotions

---

## Flags Guide

### ILLEGIBLE
- Document image blurry or unreadable
- Text too small or cut off
- Poor scan quality

### COMBINED_DOC
- Claim form and invoice in same image
- Multiple documents merged
- Cannot separate data sources

### MULTI_PET
- Multiple pet names on same invoice
- Unclear which charges apply to which pet
- Needs human to split

### NEGATIVE_LINE_ITEMS
- Discounts or credits present
- Include in table but flag for review

### NO_INVOICE_NUMBER
- No traditional invoice number found
- Using Rx or order number instead

### ESTIMATE
- Document is quote/estimate not final bill
- Amounts are proposed not actual

### MISSING_INVOICE_TOTAL
- Cannot find final total amount
- Required field missing from document

---

Use these rules to achieve 95%+ document type accuracy. When uncertain, err on side of flagging for human review.
