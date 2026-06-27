"""
SOP post-processing — Wombat / IPG rules enforced in code after Gemini extraction.

Does not replace prompts; normalizes and guards extractions so fill planning matches SOP
without weakening safety (blocked actions, no Validate, closed tool schema unchanged).
"""

import logging
import re
from datetime import date
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Wombat SOP (12/5/2024) — only these strings may be sent to the panel as incomplete_reason.
ALLOWED_INCOMPLETE_REASONS = frozenset({
    "Missing Invoice",
    "Missing Information",
    "Illegible Documents",
})

AMOUNT_FIELD_NAMES = frozenset({"net_total", "invoice_total"})
LINE_ITEM_AMOUNT_KEYS = ("unit_cost",)

# Flags that require stopping auto-fill (incomplete_reason will be set).
STOP_FILL_FLAGS = frozenset({"COMBINED_DOC"})


def sanitize_amount(value: str) -> str:
    """Strip currency formatting per SOP ($, commas, common OCR '$' substitutes)."""
    if value is None:
        return ""
    s = str(value).strip()
    s = s.replace("$", "").replace(",", "")
    # OCR: leading S or 5 sometimes substituted for $
    s = re.sub(r"^[Ss5](?=\d)", "", s)
    return s.strip()


def normalize_incomplete_reason(
    reason: Optional[str],
    extraction: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Map model free-text to one of the three allowed incomplete reasons."""
    if not reason:
        return None
    r = str(reason).strip()
    if r in ALLOWED_INCOMPLETE_REASONS:
        return r

    lower = r.lower()
    flags = set((extraction or {}).get("flags") or [])

    if "illegib" in lower or "unread" in lower or "ILLEGIBLE" in flags:
        return "Illegible Documents"
    if any(
        x in lower
        for x in (
            "missing invoice",
            "claim form only",
            "payment slip",
            "no invoice present",
            "only claim",
        )
    ):
        return "Missing Invoice"
    if "COMBINED_DOC" in flags or "multi_pet" in lower or "combined" in lower:
        return "Missing Information"
    if "net_total" in lower or "invoice_total" in lower or "missing" in lower:
        return "Missing Information"

    return "Missing Information"


def _parse_amount(value: str) -> Optional[float]:
    try:
        cleaned = sanitize_amount(value)
        if not cleaned:
            return None
        return float(cleaned)
    except ValueError:
        return None


def _filter_line_items(line_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """SOP: drop $0 rows; default qty=1; sanitize unit_cost."""
    out: List[Dict[str, Any]] = []
    for item in line_items or []:
        if not isinstance(item, dict):
            continue
        desc = (item.get("description") or "").strip()
        qty = str(item.get("qty") or "1").strip() or "1"
        unit_cost = sanitize_amount(str(item.get("unit_cost", "")))
        amount = _parse_amount(unit_cost)
        if amount is not None and amount == 0:
            continue
        out.append(
            {
                "description": desc,
                "qty": qty,
                "unit_cost": unit_cost,
            }
        )
    return out


def apply_sop_post_processing(extraction: Dict[str, Any]) -> Dict[str, Any]:
    """
    Normalize extraction dict in place to match Wombat SOP + existing safety checks.
    Called immediately after JSON parse and before fill planning.
    """
    fields = extraction.setdefault("fields", {})
    flags: List[str] = list(extraction.get("flags") or [])
    extraction["flags"] = flags

    # --- sanitize amount fields ---
    for key in AMOUNT_FIELD_NAMES:
        if key in fields and fields[key] is not None:
            fields[key] = sanitize_amount(str(fields[key]))

    tax = extraction.get("tax")
    if isinstance(tax, dict) and tax.get("amount"):
        tax["amount"] = sanitize_amount(str(tax["amount"]))

    # --- invoice date: default to today if missing (Wombat) ---
    if not (fields.get("invoice_date") or "").strip():
        fields["invoice_date"] = date.today().isoformat()
        logger.info("SOP: defaulting missing invoice_date to today")

    # --- negative totals forbidden ---
    for key in AMOUNT_FIELD_NAMES:
        val = _parse_amount(str(fields.get(key, "")))
        if val is not None and val < 0:
            extraction["incomplete_reason"] = "Missing Information"
            if "MISSING_INVOICE_TOTAL" not in flags:
                flags.append("MISSING_INVOICE_TOTAL")
            logger.warning(f"SOP: negative {key} — marking incomplete")

    # --- net_total vs invoice_total (existing safety, Wombat-aligned reason) ---
    net = _parse_amount(str(fields.get("net_total", "")))
    total = _parse_amount(str(fields.get("invoice_total", "")))
    if net is not None and total is not None and net >= total:
        logger.warning(f"SOP: net_total ({net}) >= invoice_total ({total})")
        if "MISSING_INVOICE_TOTAL" not in flags:
            flags.append("MISSING_INVOICE_TOTAL")
        extraction["incomplete_reason"] = "Missing Information"

    # --- line items ---
    extraction["line_items"] = _filter_line_items(extraction.get("line_items") or [])

    # --- doc_type incomplete (Wombat) ---
    doc_type = (extraction.get("doc_type") or "").strip().lower()
    if doc_type == "incomplete":
        if not extraction.get("incomplete_reason"):
            extraction["incomplete_reason"] = "Missing Invoice"

    # --- flags that force stop ---
    if "COMBINED_DOC" in flags:
        extraction["incomplete_reason"] = extraction.get("incomplete_reason") or "Missing Information"

    if "ILLEGIBLE" in flags and not extraction.get("incomplete_reason"):
        extraction["incomplete_reason"] = "Illegible Documents"

    # MULTI_PET alone is a panel warning only; model sets incomplete_reason if pet unknown.

    # --- normalize incomplete_reason text ---
    if extraction.get("incomplete_reason"):
        extraction["incomplete_reason"] = normalize_incomplete_reason(
            extraction["incomplete_reason"],
            extraction,
        )

    # --- stop-fill flags without reason yet ---
    if STOP_FILL_FLAGS.intersection(flags) and not extraction.get("incomplete_reason"):
        extraction["incomplete_reason"] = "Missing Information"

    return extraction


def should_stop_fill(extraction: Dict[str, Any]) -> bool:
    """True when agent must not run fill tools."""
    if extraction.get("incomplete_reason"):
        return True
    if (extraction.get("doc_type") or "").strip().lower() == "incomplete":
        return True
    return False
