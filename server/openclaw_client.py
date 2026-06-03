"""
OpenClaw element resolution wrapper.

Fallback for when CSS selectors fail - uses vision-based element detection.
"""

import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


# OpenClaw fallback descriptions for key fields
OPENCLAW_DESCRIPTIONS = {
    "invoice_date": "date field labeled invoice date or service date",
    "invoice_number": "text field for invoice number or reference number",
    "provider_name": "text input for provider or vendor name",
    "pet_name": "text field for pet name or patient name",
    "net_total": "numeric field for net total or subtotal before tax",
    "invoice_total": "numeric field for invoice total or amount due",
    "document_type_dropdown": "dropdown menu for selecting document type",
    "table_insert_row_btn": "button to add or insert a new line item row",
    "table_delete_all_btn": "button to delete all rows or clear table",
    "table_row_description": "text field for line item description in table",
    "table_row_qty": "numeric input for quantity in line item table",
    "table_row_unit_cost": "numeric input for unit cost or price in table",
}


class ElementResult:
    """Result from element resolution."""
    
    def __init__(self, selector: str, used_openclaw: bool = False):
        self.selector = selector
        self.used_openclaw = used_openclaw


class OpenClawClient:
    """Client for OpenClaw element resolution."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.enabled = config.get("OPENCLAW_FALLBACK", True)
    
    async def resolve(
        self,
        element_description: str,
        browser_session,
        fallback_selector: Optional[str] = None
    ) -> ElementResult:
        """
        Resolve element using OpenClaw vision-based detection.
        
        Args:
            element_description: Natural language description of element
            browser_session: Current browser session for screenshot
            fallback_selector: CSS selector to try first
            
        Returns:
            ElementResult with selector and whether OpenClaw was used
        """
        
        # If OpenClaw fallback disabled, just use selector
        if not self.enabled and fallback_selector:
            logger.debug(f"OpenClaw disabled, using selector: {fallback_selector}")
            return ElementResult(selector=fallback_selector, used_openclaw=False)
        
        # Try selector first if provided
        if fallback_selector:
            try:
                # TODO: Check if selector exists on page
                # If exists, return it without calling OpenClaw
                logger.debug(f"Using selector: {fallback_selector}")
                return ElementResult(selector=fallback_selector, used_openclaw=False)
            except Exception as e:
                logger.warning(f"Selector failed: {fallback_selector} - {e}")
        
        # Fallback to OpenClaw
        logger.info(f"Using OpenClaw for: {element_description}")
        
        # TODO: Implement actual OpenClaw API call
        # 1. Take screenshot of current page
        # 2. Call OpenClaw API with screenshot + element_description
        # 3. Get back coordinates or selector
        
        # Placeholder: return a generic selector
        openclaw_selector = f"[data-openclaw-target='{element_description[:20]}']"
        
        logger.info(f"OpenClaw resolved: {openclaw_selector}")
        return ElementResult(selector=openclaw_selector, used_openclaw=True)
    
    def get_description_for_field(self, field_name: str) -> Optional[str]:
        """Get OpenClaw description for a known field name."""
        return OPENCLAW_DESCRIPTIONS.get(field_name)
