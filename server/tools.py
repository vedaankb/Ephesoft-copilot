"""
Tool schema and execution engine for Ephesoft Copilot.

CRITICAL SAFETY:
- BLOCKED_ACTIONS are structurally prevented from execution
- Only closed set of TOOLS can be called
- No generic click/navigate/submit actions exist
- Every browser action resolves its target through OpenClaw first (no selector map)
"""

import logging
import asyncio
from typing import Any, Dict, List, Optional, Callable
from datetime import datetime
from enum import Enum
from pathlib import Path

logger = logging.getLogger(__name__)


class BlockedActionError(Exception):
    """Raised when agent attempts to execute a blocked action."""
    pass


class ToolExecutionError(Exception):
    """Raised when tool execution fails."""
    pass


class ActionName(str, Enum):
    """Allowed actions - this is the complete tool schema."""
    SET_DOCUMENT_TYPE = "set_document_type"
    FILL_FIELD = "fill_field"
    CLEAR_TABLE = "clear_table"
    INSERT_TABLE_ROW = "insert_table_row"
    TAKE_SCREENSHOT = "take_screenshot"
    FLAG_INCOMPLETE = "flag_incomplete"
    REPORT_COMPLETE = "report_complete"


# NON-NEGOTIABLE: Actions that are structurally blocked
BLOCKED_ACTIONS = [
    "validate",
    "skip_batch",
    "merge_documents",
    "split_documents",
    "click",
    "navigate",
    "type_arbitrary",
    "submit",
    "keyboard_shortcut",
]


# Tool definitions with schema
TOOLS = [
    {
        "name": ActionName.SET_DOCUMENT_TYPE,
        "description": "Select document type from dropdown",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_type": {
                    "type": "string",
                    "enum": [
                        "invoice",
                        "pharmacy",
                        "estimate",
                        "medical_records",
                        "claim_form",
                        "online_provider"
                    ],
                    "description": "Document type to select"
                }
            },
            "required": ["doc_type"]
        }
    },
    {
        "name": ActionName.FILL_FIELD,
        "description": "Write value to a named field",
        "parameters": {
            "type": "object",
            "properties": {
                "field_name": {
                    "type": "string",
                    "enum": [
                        "invoice_date",
                        "invoice_number",
                        "provider_name",
                        "pet_name",
                        "net_total",
                        "invoice_total"
                    ],
                    "description": "Field identifier"
                },
                "value": {
                    "type": "string",
                    "description": "Value to write (no $ signs or commas for amounts)"
                }
            },
            "required": ["field_name", "value"]
        }
    },
    {
        "name": ActionName.CLEAR_TABLE,
        "description": "Delete all existing rows from line items table",
        "parameters": {
            "type": "object",
            "properties": {}
        }
    },
    {
        "name": ActionName.INSERT_TABLE_ROW,
        "description": "Add one line item row to table",
        "parameters": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Line item description"
                },
                "qty": {
                    "type": "string",
                    "description": "Quantity"
                },
                "unit_cost": {
                    "type": "string",
                    "description": "Unit cost (no $ or commas)"
                }
            },
            "required": ["description", "qty", "unit_cost"]
        }
    },
    {
        "name": ActionName.TAKE_SCREENSHOT,
        "description": "Capture current page state for verification",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why screenshot is being taken"
                }
            },
            "required": ["reason"]
        }
    },
    {
        "name": ActionName.FLAG_INCOMPLETE,
        "description": "Mark batch as incomplete and send warning to panel",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why batch cannot be completed"
                },
                "flags": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "ILLEGIBLE",
                            "COMBINED_DOC",
                            "MULTI_PET",
                            "NEGATIVE_LINE_ITEMS",
                            "NO_INVOICE_NUMBER",
                            "ESTIMATE",
                            "MISSING_INVOICE_TOTAL"
                        ]
                    },
                    "description": "Applicable flags"
                }
            },
            "required": ["reason", "flags"]
        }
    },
    {
        "name": ActionName.REPORT_COMPLETE,
        "description": "Signal that all fields filled and ready for human review",
        "parameters": {
            "type": "object",
            "properties": {
                "doc_type": {
                    "type": "string",
                    "description": "Final document type"
                },
                "red_fields": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of fields still red (if any)"
                },
                "flags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Any flags detected"
                }
            },
            "required": ["doc_type", "red_fields", "flags"]
        }
    }
]


class Action:
    """Represents a single tool invocation."""
    
    def __init__(
        self,
        name: str,
        parameters: Dict[str, Any],
        element_description: Optional[str] = None
    ):
        self.name = name
        self.parameters = parameters
        self.element_description = element_description
        self.seq: Optional[int] = None
        self.success: bool = False
        self.error: Optional[str] = None
        self.ts: Optional[str] = None
        self.selector_used: Optional[str] = None
        self.openclaw_fallback: bool = True  # Always true in this architecture
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert action to dict for logging."""
        return {
            "seq": self.seq,
            "action": self.name,
            "parameters": self.parameters,
            "selector_used": self.selector_used,
            "openclaw_fallback": self.openclaw_fallback,
            "success": self.success,
            "error": self.error,
            "ts": self.ts or datetime.utcnow().isoformat() + "Z"
        }


async def execute(
    action: Action,
    page,
    openclaw,
    ws_update_callback: Optional[Callable] = None
) -> Dict[str, Any]:
    """
    Execute a tool action.
    
    CRITICAL: Blocked actions check runs BEFORE any browser interaction.
    
    Args:
        action: Action to execute
        page: Playwright Page object
        openclaw: OpenClawClient instance
        ws_update_callback: Optional WebSocket status update function
        
    Returns:
        Dict with execution result
        
    Raises:
        BlockedActionError: If action is in BLOCKED_ACTIONS list
        ToolExecutionError: If execution fails
    """
    
    # SAFETY CHECK: Block disallowed actions before ANY browser interaction
    if action.name in BLOCKED_ACTIONS or action.name.lower() in [b.lower() for b in BLOCKED_ACTIONS]:
        logger.warning(f"BLOCKED: Agent attempted {action.name}")
        raise BlockedActionError(f"{action.name} is not in tool schema and cannot be executed")
    
    # Verify action is in allowed TOOLS
    allowed_actions = [tool["name"] for tool in TOOLS]
    if action.name not in allowed_actions:
        logger.warning(f"UNKNOWN ACTION: {action.name}")
        raise BlockedActionError(f"{action.name} is not a recognized tool")
    
    # Mark execution timestamp
    action.ts = datetime.utcnow().isoformat() + "Z"
    
    try:
        # Route to appropriate handler
        if action.name == ActionName.SET_DOCUMENT_TYPE:
            result = await _set_document_type(action, page, openclaw)
        elif action.name == ActionName.FILL_FIELD:
            result = await _fill_field(action, page, openclaw)
        elif action.name == ActionName.CLEAR_TABLE:
            result = await _clear_table(action, page, openclaw)
        elif action.name == ActionName.INSERT_TABLE_ROW:
            result = await _insert_table_row(action, page, openclaw)
        elif action.name == ActionName.TAKE_SCREENSHOT:
            result = await _take_screenshot(action, page)
        elif action.name == ActionName.FLAG_INCOMPLETE:
            result = await _flag_incomplete(action, ws_update_callback)
        elif action.name == ActionName.REPORT_COMPLETE:
            result = await _report_complete(action, ws_update_callback)
        else:
            raise ToolExecutionError(f"Handler not implemented for {action.name}")
        
        action.success = True
        
        # Send WebSocket update if callback provided
        if ws_update_callback:
            await ws_update_callback({
                "type": "action_complete",
                "action": action.name,
                "status": result.get("status_message", "Action completed")
            })
        
        return result
        
    except Exception as e:
        action.success = False
        action.error = str(e)
        logger.error(f"Tool execution failed: {action.name} - {e}")
        
        if ws_update_callback:
            await ws_update_callback({
                "type": "action_error",
                "action": action.name,
                "error": str(e)
            })
        
        raise ToolExecutionError(f"Failed to execute {action.name}: {e}")


async def _set_document_type(
    action: Action,
    page,
    openclaw
) -> Dict[str, Any]:
    """Select document type from dropdown."""
    doc_type = action.parameters["doc_type"]
    
    html = await page.content()
    selector = await openclaw.resolve(
        description="dropdown menu for selecting document type",
        page_html=html
    )
    
    action.selector_used = selector
    await page.select_option(selector, value=doc_type)
    
    logger.info(f"Set document type: {doc_type}")
    return {
        "status_message": f"Set document type to {doc_type}",
        "value": doc_type
    }


async def _fill_field(
    action: Action,
    page,
    openclaw
) -> Dict[str, Any]:
    """Write value to named field."""
    field_name = action.parameters["field_name"]
    value = action.parameters["value"]
    
    # Strip dollar signs and commas from amounts
    if field_name in ["net_total", "invoice_total"]:
        value = value.replace("$", "").replace(",", "").strip()
    
    html = await page.content()
    selector = await openclaw.resolve(
        description=f"input field for {field_name}",
        page_html=html
    )
    
    action.selector_used = selector
    await page.fill(selector, value)
    
    logger.info(f"Filled {field_name} = {value}")
    return {
        "status_message": f"Filled {field_name}",
        "field": field_name,
        "value": value
    }


async def _clear_table(
    action: Action,
    page,
    openclaw
) -> Dict[str, Any]:
    """Delete all rows from line items table."""
    html = await page.content()
    selector = await openclaw.resolve(
        description="button to delete all rows or clear table",
        page_html=html
    )
    
    action.selector_used = selector
    await page.click(selector)
    
    logger.info("Cleared line items table")
    return {
        "status_message": "Cleared all line items"
    }


async def _insert_table_row(
    action: Action,
    page,
    openclaw
) -> Dict[str, Any]:
    """Add one line item row."""
    description = action.parameters["description"]
    qty = action.parameters["qty"]
    unit_cost = action.parameters["unit_cost"].replace("$", "").replace(",", "").strip()
    
    # 1. Click insert row button
    html = await page.content()
    insert_btn_selector = await openclaw.resolve(
        description="button to add or insert a new line item row",
        page_html=html
    )
    await page.click(insert_btn_selector)
    
    # Wait a tiny bit for the row to be added to the DOM
    await asyncio.sleep(0.2)
    
    # 2. Fill row fields (description, qty, unit_cost)
    html = await page.content()
    desc_selector = await openclaw.resolve(
        description="the empty or newly added description input field in the line items table",
        page_html=html
    )
    qty_selector = await openclaw.resolve(
        description="the empty or newly added quantity input field in the line items table",
        page_html=html
    )
    cost_selector = await openclaw.resolve(
        description="the empty or newly added unit cost input field in the line items table",
        page_html=html
    )
    
    action.selector_used = f"{insert_btn_selector} -> {desc_selector}"
    
    await page.fill(desc_selector, description)
    await page.fill(qty_selector, qty)
    await page.fill(cost_selector, unit_cost)
    
    logger.info(f"Inserted row: {description} x{qty} @ {unit_cost}")
    return {
        "status_message": f"Added line item: {description}",
        "row": {
            "description": description,
            "qty": qty,
            "unit_cost": unit_cost
        }
    }


async def _take_screenshot(
    action: Action,
    page
) -> Dict[str, Any]:
    """Capture page screenshot."""
    reason = action.parameters["reason"]
    
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"screenshot_{timestamp}.png"
    path = Path.cwd() / "logs" / "screenshots" / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    
    await page.screenshot(path=str(path))
    
    logger.info(f"Screenshot taken: {reason} -> {path}")
    return {
        "status_message": f"Screenshot: {reason}",
        "screenshot_path": str(path)
    }


async def _flag_incomplete(
    action: Action,
    ws_update_callback
) -> Dict[str, Any]:
    """Mark batch as incomplete and send warning to panel."""
    reason = action.parameters["reason"]
    flags = action.parameters["flags"]
    
    logger.warning(f"Batch flagged incomplete: {reason} - flags: {flags}")
    
    if ws_update_callback:
        await ws_update_callback({
            "type": "incomplete",
            "reason": reason,
            "flags": flags
        })
    
    return {
        "status_message": f"Flagged incomplete: {reason}",
        "reason": reason,
        "flags": flags
    }


async def _report_complete(
    action: Action,
    ws_update_callback
) -> Dict[str, Any]:
    """Signal completion to panel."""
    doc_type = action.parameters["doc_type"]
    red_fields = action.parameters["red_fields"]
    flags = action.parameters["flags"]
    
    logger.info(f"Batch complete: {doc_type}, red_fields={len(red_fields)}, flags={flags}")
    
    if ws_update_callback:
        await ws_update_callback({
            "type": "complete",
            "doc_type": doc_type,
            "red_fields": red_fields,
            "flags": flags
        })
    
    return {
        "status_message": "Fill complete - ready for human review",
        "doc_type": doc_type,
        "red_fields": red_fields,
        "flags": flags
    }


def get_tools_for_gemini() -> List[Dict[str, Any]]:
    """
    Return tool schema formatted for Gemini function calling.
    
    Returns:
        List of tool definitions
    """
    return TOOLS


def validate_action_parameters(action_name: str, parameters: Dict[str, Any]) -> bool:
    """
    Validate action parameters against tool schema.
    
    Args:
        action_name: Name of the action
        parameters: Parameters to validate
        
    Returns:
        True if valid, raises ValueError otherwise
    """
    tool = next((t for t in TOOLS if t["name"] == action_name), None)
    
    if not tool:
        raise ValueError(f"Unknown action: {action_name}")
    
    required = tool["parameters"].get("required", [])
    for req in required:
        if req not in parameters:
            raise ValueError(f"Missing required parameter: {req} for action {action_name}")
    
    return True
