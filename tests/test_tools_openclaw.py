"""
Unit tests for the closed tool schema and OpenClaw resolution.

These tests exercise the same logical surface as the live system but use:
  - a FakeChannel that records DOM commands instead of touching a real browser
  - a FakeOpenClaw that returns predetermined selectors instead of calling Gemini

Result: tests verify the safety guarantees and the action plumbing without
requiring Playwright, Chrome, or a network.
"""

import unittest
import asyncio
from pathlib import Path

from server.tools import (
    Action,
    ActionName,
    execute,
    BlockedActionError,
)


# ---------- fakes ----------

class FakeChannel:
    """In-process channel that records every DOM command sent."""

    def __init__(self, html: str = "<html><body></body></html>"):
        self.html = html
        self.events = []   # list of (cmd, kwargs)
        # internal state for assertions
        self.values = {}        # selector -> filled value
        self.selected = {}      # selector -> selected value
        self.clicks = []
        # track table rows for the insert/clear flow
        self.rows = []          # each row is {description, qty, unit_cost}

    async def get_html(self) -> str:
        self.events.append(("get_html", {}))
        return self.html

    async def screenshot(self) -> str:
        self.events.append(("screenshot", {}))
        return ""  # base64 empty PNG is fine for tests

    async def fill(self, selector: str, value: str):
        self.events.append(("fill", {"selector": selector, "value": value}))
        self.values[selector] = value
        # rough simulation of a row being filled: stash by selector tag
        if selector.endswith("description"):
            self.rows.append({"description": value, "qty": "", "unit_cost": ""})
        elif selector.endswith("qty") and self.rows:
            self.rows[-1]["qty"] = value
        elif selector.endswith("unit_cost") and self.rows:
            self.rows[-1]["unit_cost"] = value

    async def click(self, selector: str):
        self.events.append(("click", {"selector": selector}))
        self.clicks.append(selector)
        if "delete_all" in selector or "clear" in selector:
            self.rows.clear()

    async def select(self, selector: str, value: str):
        self.events.append(("select", {"selector": selector, "value": value}))
        self.selected[selector] = value


class FakeOpenClaw:
    """Returns deterministic selectors based on the natural language description."""

    DEFAULT_MAP = {
        "dropdown menu for selecting document type": "#document_type_dropdown",
        "input field for invoice_date": "#invoice_date",
        "input field for invoice_number": "#invoice_number",
        "input field for provider_name": "#provider_name",
        "input field for pet_name": "#pet_name",
        "input field for net_total": "#net_total",
        "input field for invoice_total": "#invoice_total",
        "button to delete all rows or clear the line items table": "#table_delete_all_btn",
        "button to add or insert a new line item row": "#table_insert_row_btn",
        "the most recently added empty description input in the line items table": ".row-description",
        "the most recently added empty quantity input in the line items table": ".row-qty",
        "the most recently added empty unit cost input in the line items table": ".row-unit_cost",
    }

    async def resolve(self, description: str, page_html: str) -> str:
        for key, sel in self.DEFAULT_MAP.items():
            if key == description:
                return sel
        # Fall back to a marker selector so tests can see what was asked
        return f"[data-unmapped='{description[:30]}']"


# ---------- tests ----------

class TestSafety(unittest.IsolatedAsyncioTestCase):

    async def test_blocked_actions_raise_immediately(self):
        channel = FakeChannel()
        openclaw = FakeOpenClaw()
        for blocked in ["validate", "skip_batch", "merge_documents", "split_documents",
                        "click", "navigate", "type_arbitrary", "submit"]:
            with self.subTest(action=blocked):
                action = Action(name=blocked, parameters={})
                with self.assertRaises(BlockedActionError):
                    await execute(action, channel, openclaw)
                # Critical: NO DOM command was ever sent for a blocked action
                self.assertEqual(channel.events, [], f"{blocked} leaked DOM events!")

    async def test_unknown_action_is_blocked(self):
        channel = FakeChannel()
        openclaw = FakeOpenClaw()
        action = Action(name="set_validate_button", parameters={})
        with self.assertRaises(BlockedActionError):
            await execute(action, channel, openclaw)


class TestFieldOps(unittest.IsolatedAsyncioTestCase):

    async def test_set_document_type_uses_select(self):
        channel = FakeChannel()
        openclaw = FakeOpenClaw()
        action = Action(name=ActionName.SET_DOCUMENT_TYPE, parameters={"doc_type": "pharmacy"})
        await execute(action, channel, openclaw)
        self.assertEqual(channel.selected["#document_type_dropdown"], "pharmacy")
        self.assertTrue(action.success)

    async def test_fill_field_strips_currency_and_commas_for_amounts(self):
        channel = FakeChannel()
        openclaw = FakeOpenClaw()

        a1 = Action(name=ActionName.FILL_FIELD, parameters={"field_name": "invoice_date", "value": "03/15/2024"})
        a2 = Action(name=ActionName.FILL_FIELD, parameters={"field_name": "net_total", "value": "$1,127.50"})
        a3 = Action(name=ActionName.FILL_FIELD, parameters={"field_name": "invoice_total", "value": "$1,250.00"})

        await execute(a1, channel, openclaw)
        await execute(a2, channel, openclaw)
        await execute(a3, channel, openclaw)

        self.assertEqual(channel.values["#invoice_date"], "03/15/2024")
        self.assertEqual(channel.values["#net_total"], "1127.50")
        self.assertEqual(channel.values["#invoice_total"], "1250.00")


class TestTableOps(unittest.IsolatedAsyncioTestCase):

    async def test_clear_then_insert_row_strips_currency(self):
        channel = FakeChannel()
        openclaw = FakeOpenClaw()

        await execute(Action(name=ActionName.CLEAR_TABLE, parameters={}), channel, openclaw)
        self.assertIn("#table_delete_all_btn", channel.clicks)

        await execute(
            Action(
                name=ActionName.INSERT_TABLE_ROW,
                parameters={"description": "Exam fee", "qty": "1", "unit_cost": "$65.00"},
            ),
            channel,
            openclaw,
        )

        self.assertIn("#table_insert_row_btn", channel.clicks)
        self.assertEqual(len(channel.rows), 1)
        row = channel.rows[0]
        self.assertEqual(row["description"], "Exam fee")
        self.assertEqual(row["qty"], "1")
        self.assertEqual(row["unit_cost"], "65.00")  # stripped


class TestExtensionChannelAllowlist(unittest.IsolatedAsyncioTestCase):
    """Defense in depth: the channel itself must reject disallowed cmds."""

    async def test_disallowed_cmd_rejected(self):
        from server.extension_channel import ExtensionChannel
        ch = ExtensionChannel()
        with self.assertRaises(ValueError):
            await ch._send_cmd("validate")
        with self.assertRaises(ValueError):
            await ch._send_cmd("navigate", url="https://example.com")


if __name__ == "__main__":
    unittest.main()
