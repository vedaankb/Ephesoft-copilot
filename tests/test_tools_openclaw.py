"""
Unit tests for tools.py and openclaw_client.py.

Verifies:
- Safety checks (BlockedActionError)
- OpenClaw resolution logic
- Tool execution against mock HTML using Playwright
"""

import unittest
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

from server.tools import Action, ActionName, execute, BlockedActionError, ToolExecutionError
from server.openclaw_client import OpenClawClient


class MockOpenClawClient:
    """Mock OpenClaw client that returns pre-determined selectors for testing."""
    
    def __init__(self):
        # Map descriptions to selectors in fixtures/field_view.html
        self.selector_map = {
            "dropdown menu for selecting document type": "#document_type_dropdown",
            "input field for invoice_date": "#invoice_date",
            "input field for invoice_number": "#invoice_number",
            "input field for provider_name": "#provider_name",
            "input field for pet_name": "#pet_name",
            "input field for net_total": "#net_total",
            "input field for invoice_total": "#invoice_total",
            "button to delete all rows or clear table": "#table_delete_all_btn",
            "button to add or insert a new line item row": "#table_insert_row_btn",
            "the empty or newly added description input field in the line items table": ".table_row_description",
            "the empty or newly added quantity input field in the line items table": ".table_row_qty",
            "the empty or newly added unit cost input field in the line items table": ".table_row_unit_cost",
        }
    
    async def resolve(self, description: str, page_html: str) -> str:
        if description in self.selector_map:
            return self.selector_map[description]
        raise ValueError(f"MockOpenClaw: Unknown description '{description}'")


class TestToolsAndOpenClaw(unittest.IsolatedAsyncioTestCase):
    
    async def asyncSetUp(self):
        """Set up Playwright and open mock HTML."""
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(headless=True)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        
        # Load mock field view
        fixture_path = Path.cwd() / "fixtures" / "field_view.html"
        await self.page.goto(f"file://{fixture_path}")
        
        self.mock_openclaw = MockOpenClawClient()
        
    async def asyncTearDown(self):
        """Clean up Playwright resources."""
        await self.context.close()
        await self.browser.close()
        await self.playwright.stop()
        
    async def test_blocked_actions(self):
        """Verify that blocked actions raise BlockedActionError immediately."""
        blocked_actions = ["validate", "skip_batch", "merge_documents", "split_documents"]
        
        for action_name in blocked_actions:
            action = Action(name=action_name, parameters={})
            with self.assertRaises(BlockedActionError):
                await execute(action, self.page, self.mock_openclaw)
                
    async def test_set_document_type(self):
        """Verify set_document_type tool selects the correct option."""
        action = Action(
            name=ActionName.SET_DOCUMENT_TYPE,
            parameters={"doc_type": "pharmacy"}
        )
        
        result = await execute(action, self.page, self.mock_openclaw)
        self.assertTrue(action.success)
        self.assertEqual(result["value"], "pharmacy")
        
        # Verify on page
        selected_val = await self.page.eval_on_selector("#document_type_dropdown", "el => el.value")
        self.assertEqual(selected_val, "pharmacy")
        
    async def test_fill_field(self):
        """Verify fill_field tool fills inputs correctly and strips formatting."""
        # Test filling date
        action_date = Action(
            name=ActionName.FILL_FIELD,
            parameters={"field_name": "invoice_date", "value": "03/15/2024"}
        )
        await execute(action_date, self.page, self.mock_openclaw)
        self.assertTrue(action_date.success)
        
        date_val = await self.page.eval_on_selector("#invoice_date", "el => el.value")
        self.assertEqual(date_val, "03/15/2024")
        
        # Test filling net_total with formatting (should strip $ and commas)
        action_total = Action(
            name=ActionName.FILL_FIELD,
            parameters={"field_name": "net_total", "value": "$1,127.50"}
        )
        await execute(action_total, self.page, self.mock_openclaw)
        self.assertTrue(action_total.success)
        
        total_val = await self.page.eval_on_selector("#net_total", "el => el.value")
        self.assertEqual(total_val, "1127.50")
        
    async def test_table_operations(self):
        """Verify clear_table and insert_table_row tools."""
        # 1. Insert row
        action_insert = Action(
            name=ActionName.INSERT_TABLE_ROW,
            parameters={
                "description": "Consultation",
                "qty": "1",
                "unit_cost": "$65.00"
            }
        )
        await execute(action_insert, self.page, self.mock_openclaw)
        self.assertTrue(action_insert.success)
        
        # Verify row was added
        rows_count = await self.page.locator("#line_items_tbody tr").count()
        self.assertEqual(rows_count, 1)
        
        desc_val = await self.page.locator(".table_row_description").first.input_value()
        qty_val = await self.page.locator(".table_row_qty").first.input_value()
        cost_val = await self.page.locator(".table_row_unit_cost").first.input_value()
        
        self.assertEqual(desc_val, "Consultation")
        self.assertEqual(qty_val, "1")
        self.assertEqual(cost_val, "65.00")
        
        # 2. Clear table
        action_clear = Action(name=ActionName.CLEAR_TABLE, parameters={})
        await execute(action_clear, self.page, self.mock_openclaw)
        self.assertTrue(action_clear.success)
        
        rows_count_after = await self.page.locator("#line_items_tbody tr").count()
        self.assertEqual(rows_count_after, 0)


if __name__ == "__main__":
    unittest.main()
