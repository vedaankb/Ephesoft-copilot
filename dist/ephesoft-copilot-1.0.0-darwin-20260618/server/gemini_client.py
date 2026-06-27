"""
Gemini 2.5 Pro API client.

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
from server.paths import resource_path
from server.credentials import load_gemini_api_key, validate_gemini_api_key, configure_gemini
from server.sop import apply_sop_post_processing, should_stop_fill

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
            
        self.model_name = config.get("GEMINI_MODEL", "gemini-3.1-pro-preview")
        self.model = genai.GenerativeModel(self.model_name) if self.api_key else None
    
    def _load_prompt(self, path: str) -> str:
        """Load prompt file from bundled resources."""
        full = resource_path(path)
        try:
            with open(full, "r") as f:
                return f.read()
        except FileNotFoundError:
            logger.warning(f"Prompt file not found: {full}")
            return ""
            
    def build_system_prompt(self) -> str:
        """Assemble system prompt: agent instructions + Wombat SOP + doc type reference."""
        return "\n\n".join([
            self._load_prompt("prompts/system.md"),
            self._load_prompt("prompts/sop_rules.md"),
            self._load_prompt("prompts/doc_types.md"),
        ])
    
    async def extract(
        self,
        screenshot_b64: str,
        doc_bytes: bytes,
        screenshot_frames: Optional[List[str]] = None,
        html_chunks: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        """
        Extract structured data from document.
        
        Args:
            screenshot_b64: Base64-encoded screenshot of Ephesoft page
            doc_bytes: Raw bytes of the document being processed
            screenshot_frames: Optional additional viewport screenshots
            html_chunks: Optional per-viewport HTML chunks
            
        Returns:
            Extraction dict with doc_type, fields, line_items, tax, flags
        """
        if not self.api_key or not self.model:
            validate_gemini_api_key("")  # raises with setup instructions
            
        logger.info("Extracting data with Gemini 3.1 Pro...")
        
        parts = []
        
        # 1. Injected system prompt
        system_prompt = self.build_system_prompt()
        parts.append(system_prompt)
        
        # 2. Add screenshot(s) of the Ephesoft portal.
        # If multi-frame bundle exists, include all frames and ask model to merge.
        all_frames = [screenshot_b64] + list(screenshot_frames or [])
        added_frames = 0
        for idx, frame_b64 in enumerate(all_frames, 1):
            if not frame_b64:
                continue
            try:
                parts.append({
                    "mime_type": "image/png",
                    "data": base64.b64decode(frame_b64)
                })
                parts.append(f"Ephesoft viewport screenshot #{idx}.")
                added_frames += 1
            except Exception as e:
                logger.error(f"Failed to decode screenshot frame #{idx}: {e}")
        if added_frames == 0:
            logger.warning("No valid screenshot frames supplied to extraction")

        # 2b. Include visible HTML chunks captured while scrolling.
        # These chunks help extraction when fields are below the fold.
        if html_chunks:
            for i, chunk in enumerate(html_chunks[:8], 1):
                if not chunk:
                    continue
                parts.append(
                    f"Visible HTML chunk #{i} (truncated):\n{str(chunk)[:10000]}"
                )
            
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
        parts.append("""Analyze the document and Ephesoft screenshot per the SOP (Wombat / IPG).
Return ONLY valid JSON matching this schema:
{
  "doc_type": "invoice|pharmacy|estimate|medical_records|claim_form|online_provider|incomplete",
  "confidence": 94,
  "fields": {
    "invoice_date": "YYYY-MM-DD",
    "invoice_number": "INV-00342",
    "provider_name": "City Vet Clinic",
    "pet_name": "Max",
    "net_total": "117.29",
    "invoice_total": "127.98"
  },
  "line_items": [{"description": "Exam fee", "qty": "1", "unit_cost": "65.00"}],
  "tax": {"present": true, "amount": "10.69"},
  "flags": [],
  "incomplete_reason": null
}

Critical SOP reminders:
- Petco/Vetco receipts → doc_type invoice (not pharmacy). Treatment plan / open invoice → invoice.
- Claim form + invoice on one image → invoice (invoice fields only); NOT COMBINED_DOC.
- Two separate invoices on one image → flag COMBINED_DOC, incomplete_reason "Missing Information".
- incomplete_reason must be EXACTLY one of: "Missing Invoice", "Missing Information", "Illegible Documents" — or null if fill can proceed.
- net_total = invoice_total minus all taxes; must be < invoice_total when tax exists; never negative totals.
- Omit $0 line items; default qty to 1; use "your fee" column when present.
- Strip $ and commas from all amounts in JSON.
- Missing invoice_date on document → use today's date.
- Rx/order as invoice_number → flag NO_INVOICE_NUMBER.
- Warning flags only in "flags"; use incomplete_reason when auto-fill must stop.
- You may receive multiple viewport screenshots and HTML chunks from one scroll pass.
  Merge evidence across all frames/chunks before deciding values.
  Prefer explicit, consistent values seen in multiple places.
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

            self.validate_extraction_schema(extraction)
            apply_sop_post_processing(extraction)

            logger.info(
                f"Extraction successful: {extraction.get('doc_type')} "
                f"({extraction.get('confidence')}%)"
                + (f" incomplete={extraction.get('incomplete_reason')}" if extraction.get("incomplete_reason") else "")
            )
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
        if should_stop_fill(extraction):
            logger.info("SOP: skipping plan_actions — batch marked incomplete")
            return []

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
            
        logger.info("Verifying filled fields with Gemini 3.1 Pro...")
        
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

        return True
