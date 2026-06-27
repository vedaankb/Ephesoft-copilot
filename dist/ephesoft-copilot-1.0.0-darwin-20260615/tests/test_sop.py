"""Unit tests for Wombat SOP post-processing (server/sop.py)."""

import unittest
from datetime import date

from server.sop import (
    ALLOWED_INCOMPLETE_REASONS,
    apply_sop_post_processing,
    normalize_incomplete_reason,
    sanitize_amount,
    should_stop_fill,
)


class TestSanitizeAmount(unittest.TestCase):
    def test_strips_currency(self):
        self.assertEqual(sanitize_amount("$1,127.50"), "1127.50")

    def test_strips_leading_s_ocr(self):
        self.assertEqual(sanitize_amount("S65.00"), "65.00")


class TestNormalizeIncomplete(unittest.TestCase):
    def test_allowed_passthrough(self):
        for r in ALLOWED_INCOMPLETE_REASONS:
            self.assertEqual(normalize_incomplete_reason(r), r)

    def test_maps_illegible(self):
        self.assertEqual(
            normalize_incomplete_reason("document is illegible"),
            "Illegible Documents",
        )

    def test_maps_net_total_error(self):
        self.assertEqual(
            normalize_incomplete_reason("net_total is not less than invoice_total"),
            "Missing Information",
        )


class TestApplySopPostProcessing(unittest.TestCase):
    def test_net_ge_total_sets_missing_information(self):
        ext = {
            "doc_type": "invoice",
            "confidence": 90,
            "fields": {"net_total": "130", "invoice_total": "127.98"},
            "flags": [],
            "line_items": [],
        }
        apply_sop_post_processing(ext)
        self.assertEqual(ext["incomplete_reason"], "Missing Information")
        self.assertIn("MISSING_INVOICE_TOTAL", ext["flags"])

    def test_drops_zero_line_items(self):
        ext = {
            "doc_type": "invoice",
            "confidence": 90,
            "fields": {},
            "flags": [],
            "line_items": [
                {"description": "Free", "qty": "1", "unit_cost": "0"},
                {"description": "Exam", "qty": "1", "unit_cost": "65.00"},
            ],
        }
        apply_sop_post_processing(ext)
        self.assertEqual(len(ext["line_items"]), 1)
        self.assertEqual(ext["line_items"][0]["description"], "Exam")

    def test_defaults_missing_invoice_date(self):
        ext = {
            "doc_type": "invoice",
            "confidence": 90,
            "fields": {},
            "flags": [],
            "line_items": [],
        }
        apply_sop_post_processing(ext)
        self.assertEqual(ext["fields"]["invoice_date"], date.today().isoformat())

    def test_combined_doc_stops_fill(self):
        ext = {
            "doc_type": "invoice",
            "confidence": 90,
            "fields": {"net_total": "10", "invoice_total": "12"},
            "flags": ["COMBINED_DOC"],
            "line_items": [],
        }
        apply_sop_post_processing(ext)
        self.assertTrue(should_stop_fill(ext))
        self.assertEqual(ext["incomplete_reason"], "Missing Information")

    def test_doc_type_incomplete(self):
        ext = {
            "doc_type": "incomplete",
            "confidence": 90,
            "fields": {},
            "flags": [],
            "line_items": [],
        }
        apply_sop_post_processing(ext)
        self.assertEqual(ext["incomplete_reason"], "Missing Invoice")
        self.assertTrue(should_stop_fill(ext))


if __name__ == "__main__":
    unittest.main()
