"""
Gemini 1.5 Pro Vision API client.

Handles:
- Document data extraction (OCR + structured parsing)
- Action planning
- Post-fill verification
"""

import logging
import base64
import json
import re
from typing import Dict, Any, List, Optional
import google.generativeai as genai

from server.tools import Action, ActionName
from server.credentials import load_gemini_api_key, validate_gemini_api_key, configure_gemini

logger = logging.getLogger(__name__)


class GeminiClient:
    """Client for Gemini Vision API."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.api_key = load_gemini_api_key(config)
        
        if self.api_key:
            try:
                configure_gemini(self.api_key)
            except ValueError as e:
                logger.error(str(e))
                self.api_key = None
        else:
            logger.warning("GEMINI_API_KEY not found (env, keychain, or config.json)")
            
        self.model_name = config.get("GEMINI_MODEL", "gemini-1.5-flash")
        self.model = genai.GenerativeModel(self.model_name) if self.api_key else None
    
    def _load_prompt(self, path: str) -> str:
        """Load prompt file."""
        try:
            with open(path, "r") as f:
                return f.read()
        except FileNotFoundError:
            logger.warning(f"Prompt file not found: {path}")
            return ""
            
    def build_system_prompt(self) -> str:
        """Assemble system prompt from system, sop_rules, and doc_types prompts."""
        return "\n\n".join([
            self._load_prompt("prompts/system.md"),
            self._load_prompt("prompts/sop_rules.md"),
            self._load_prompt("prompts/doc_types.md"),
        ])
    
    async def extract(
        self,
        screenshot_b64: str,
        doc_bytes: bytes
    ) -> Dict[str, Any]:
        """
        Extract structured data from document.
        
        Args:
            screenshot_b64: Base64-encoded screenshot of Ephesoft page
            doc_bytes: Raw bytes of the document being processed
            
        Returns:
            Extraction dict with doc_type, fields, line_items, tax, flags
        """
        if not self.api_key or not self.model:
            validate_gemini_api_key("")  # raises with setup instructions
            
        logger.info("Extracting data with Gemini 1.5 Pro...")
        
        parts = []
        
        # 1. Injected system prompt
        system_prompt = self.build_system_prompt()
        parts.append(system_prompt)
        
        # 2. Add the screenshot of the Ephesoft portal
        try:
            parts.append({
                "mime_type": "image/png",
                "data": base64.b64decode(screenshot_b64)
            })
            parts.append("This is the screenshot of the current Ephesoft portal page.")
        except Exception as e:
            logger.error(f"Failed to decode screenshot: {e}")
            
        # 3. Add the document being processed (PDF or image)
        if doc_bytes:
            mime_type = "application/pdf"
            if doc_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                mime_type = "image/png"
            elif doc_bytes.startswith(b"\xff\xd8\xff"):
                mime_type = "image/jpeg"
                
            parts.append({
                "mime_type": mime_type,
                "data": doc_bytes
            })
            parts.append("This is the document to extract data from.")
            
        # 4. Request JSON response matching extraction schema
        parts.append("""Please analyze the document and the Ephesoft portal screenshot, and extract the required fields as specified in the SOP rules.
Return ONLY a valid JSON object matching the following schema:
{
  "doc_type": "invoice|pharmacy|estimate|medical_records|claim_form|online_provider",
  "confidence": 94,
  "fields": {
    "invoice_date": "YYYY-MM-DD",
    "invoice_number": "INV-00342",
    "provider_name": "City Vet Clinic",
    "pet_name": "Max",
    "net_total": "117.29",
    "invoice_total": "127.98"
  },
  "line_items": [
    {"description": "Exam fee", "qty": "1", "unit_cost": "65.00"}
  ],
  "tax": {"present": true, "amount": "10.69"},
  "flags": [],
  "incomplete_reason": null
}

Ensure all SOP rules are strictly followed:
- net_total must be less than invoice_total. If not, set "incomplete_reason" to "net_total is not less than invoice_total" and add "MISSING_INVOICE_TOTAL" to flags.
- Strip all $ signs and commas from amounts.
- Dates must be numeric format only.
- If no invoice number is found, use Rx number or order number and add "NO_INVOICE_NUMBER" to flags.
- If any safety flags are triggered (e.g., ILLEGIBLE, COMBINED_DOC, MULTI_PET, NEGATIVE_LINE_ITEMS, ESTIMATE), add them to the "flags" list. If the document cannot be processed, set "incomplete_reason" to the reason why.
""")

        try:
            # Call Gemini API with JSON output constraint
            response = await self.model.generate_content_async(
                parts,
                generation_config={"response_mime_type": "application/json"}
            )
            text = response.text.strip()
            
            # Clean markdown formatting if any
            if text.startswith("```"):
                text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
                text = re.sub(r'\s*```$', '', text)
                text = text.strip()
                
            extraction = json.loads(text)
            
            # Validate extraction schema
            self.validate_extraction_schema(extraction)
            
            logger.info(f"Extraction successful: {extraction.get('doc_type')} with confidence {extraction.get('confidence')}%")
            return extraction
            
        except Exception as e:
            err = str(e)
            logger.error(f"Gemini extraction failed: {e}")
            if "401" in err or "ACCESS_TOKEN" in err or "authentication" in err.lower():
                raise RuntimeError(
                    "Gemini authentication failed (401). Your API key is missing or invalid. "
                    "Create a key at https://aistudio.google.com/apikey (starts with AIza), "
                    "then add it to config.json or re-run: .venv/bin/python setup.py"
                ) from e
            raise RuntimeError(f"Gemini extraction failed: {e}") from e
    
    async def plan_actions(self, extraction: Dict[str, Any]) -> List[Action]:
        """
        Convert extraction into ordered action list.
        
        Args:
            extraction: Extraction result from extract()
            
        Returns:
            List of Action objects
        """
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
                        "qty": str(item["qty"]),
                        "unit_cost": str(item["unit_cost"])
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
        if not self.api_key or not self.model:
            validate_gemini_api_key("")
            
        logger.info("Verifying filled fields with Gemini 1.5 Pro...")
        
        parts = []
        parts.append(self.build_system_prompt())
        parts.append({
            "mime_type": "image/png",
            "data": base64.b64decode(screenshot_b64)
        })
        parts.append("""This is a screenshot of the Ephesoft portal after the fields have been filled.
Analyze the screenshot and check if there are any red/error fields, empty required fields, or validation warnings.
Return ONLY a valid JSON object matching the following schema:
{
  "ok": true,
  "red_fields": [],
  "notes": "All fields accepted"
}

If any fields are highlighted in red or show error/validation messages, list them in "red_fields" and set "ok" to false.
""")
        
        try:
            response = await self.model.generate_content_async(
                parts,
                generation_config={"response_mime_type": "application/json"}
            )
            text = response.text.strip()
            
            # Clean markdown formatting if any
            if text.startswith("```"):
                import re
                text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
                text = re.sub(r'\s*```$', '', text)
                text = text.strip()
                
            verification = json.loads(text)
            logger.info(f"Verification complete: ok={verification.get('ok')}, red_fields={verification.get('red_fields')}")
            return verification
        except Exception as e:
            logger.error(f"Verification pass failed: {e}")
            return {
                "ok": False,
                "red_fields": [],
                "notes": f"Verification failed: {e}"
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
                    # Force flag if net_total >= invoice_total
                    if "flags" not in extraction:
                        extraction["flags"] = []
                    if "MISSING_INVOICE_TOTAL" not in extraction["flags"]:
                        extraction["flags"].append("MISSING_INVOICE_TOTAL")
                    extraction["incomplete_reason"] = f"net_total ({net}) must be less than invoice_total ({total})"
            except ValueError:
                logger.warning("Could not parse amounts for validation")
        
        return True
