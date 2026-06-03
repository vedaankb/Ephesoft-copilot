"""
Gemini 1.5 Pro Vision API client.

Handles:
- Document data extraction (OCR + structured parsing)
- Action planning
- Post-fill verification
"""

import logging
from typing import Dict, Any, List, Optional
import json

logger = logging.getLogger(__name__)


class GeminiClient:
    """Client for Gemini Vision API."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.api_key = config.get("GEMINI_API_KEY")
        
        if not self.api_key:
            logger.warning("GEMINI_API_KEY not set - vision extraction will fail")
        
        # Load prompts
        self.system_prompt = self._load_prompt("prompts/system.md")
        self.doc_types_prompt = self._load_prompt("prompts/doc_types.md")
    
    def _load_prompt(self, path: str) -> str:
        """Load prompt file."""
        try:
            with open(path, "r") as f:
                return f.read()
        except FileNotFoundError:
            logger.warning(f"Prompt file not found: {path}")
            return ""
    
    async def extract(
        self,
        screenshot_b64: str,
        doc_urls: List[str]
    ) -> Dict[str, Any]:
        """
        Extract structured data from document.
        
        Args:
            screenshot_b64: Base64-encoded screenshot of Ephesoft page
            doc_urls: URLs to document images/PDFs
            
        Returns:
            Extraction dict with doc_type, fields, line_items, tax, flags
        """
        
        # TODO: Implement actual Gemini API call
        # 1. Construct prompt with system + doc_types
        # 2. Include screenshot + doc images
        # 3. Request JSON response matching extraction schema
        # 4. Parse and validate response
        
        logger.info("Extracting data with Gemini...")
        
        # Placeholder response
        return {
            "doc_type": "invoice",
            "confidence": 94,
            "fields": {
                "invoice_date": "03/15/2024",
                "invoice_number": "INV-00342",
                "provider_name": "City Vet Clinic",
                "pet_name": "Max",
                "net_total": "117.29",
                "invoice_total": "127.98"
            },
            "line_items": [
                {"description": "Exam fee", "qty": "1", "unit_cost": "65.00"},
                {"description": "Amoxicillin 500mg", "qty": "14", "unit_cost": "3.75"}
            ],
            "tax": {
                "present": True,
                "amount": "10.69",
                "items": ["HST 10.69"]
            },
            "flags": [],
            "incomplete_reason": None
        }
    
    async def plan_actions(self, extraction: Dict[str, Any]) -> List[Any]:
        """
        Convert extraction into ordered action list.
        
        Args:
            extraction: Extraction result from extract()
            
        Returns:
            List of Action objects
        """
        from server.tools import Action, ActionName
        
        actions = []
        
        # 1. Set document type
        actions.append(Action(
            name=ActionName.SET_DOCUMENT_TYPE,
            parameters={"doc_type": extraction["doc_type"]}
        ))
        
        # 2. Fill fields
        for field_name, value in extraction.get("fields", {}).items():
            if value:  # Only fill if value present
                actions.append(Action(
                    name=ActionName.FILL_FIELD,
                    parameters={"field_name": field_name, "value": str(value)}
                ))
        
        # 3. Clear and populate line items table
        line_items = extraction.get("line_items", [])
        if line_items:
            # Clear existing rows first
            actions.append(Action(
                name=ActionName.CLEAR_TABLE,
                parameters={}
            ))
            
            # Insert each row
            for item in line_items:
                actions.append(Action(
                    name=ActionName.INSERT_TABLE_ROW,
                    parameters={
                        "description": item["description"],
                        "qty": item["qty"],
                        "unit_cost": item["unit_cost"]
                    }
                ))
        
        logger.info(f"Planned {len(actions)} actions")
        return actions
    
    async def verify(self, screenshot_b64: str) -> Dict[str, Any]:
        """
        Verify filled fields by analyzing post-fill screenshot.
        
        Checks for:
        - Red/error fields
        - Required fields still empty
        - Validation errors
        
        Args:
            screenshot_b64: Base64-encoded screenshot after fill
            
        Returns:
            Dict with ok, red_fields[], notes
        """
        
        # TODO: Implement actual Gemini verification call
        # 1. Send screenshot with verify prompt
        # 2. Ask to identify any red/error fields
        # 3. Return list of problematic fields
        
        logger.info("Verifying with Gemini...")
        
        # Placeholder response
        return {
            "ok": True,
            "red_fields": [],
            "notes": "All fields accepted"
        }
    
    def validate_extraction_schema(self, extraction: Dict[str, Any]) -> bool:
        """
        Validate extraction response matches expected schema.
        
        Args:
            extraction: Extraction dict from Gemini
            
        Returns:
            True if valid, raises ValueError otherwise
        """
        required_keys = ["doc_type", "confidence", "fields"]
        
        for key in required_keys:
            if key not in extraction:
                raise ValueError(f"Missing required key in extraction: {key}")
        
        # Validate net_total < invoice_total if both present
        fields = extraction.get("fields", {})
        if "net_total" in fields and "invoice_total" in fields:
            try:
                net = float(fields["net_total"].replace("$", "").replace(",", ""))
                total = float(fields["invoice_total"].replace("$", "").replace(",", ""))
                
                if net >= total:
                    logger.warning(
                        f"net_total ({net}) should be less than invoice_total ({total})"
                    )
                    # Flag but don't fail - human will review
            except ValueError:
                logger.warning("Could not parse amounts for validation")
        
        return True
