"""
Agent orchestration - fill loop and next loop.

Coordinates:
- Browser automation
- Gemini vision extraction
- Action planning and execution
- Verification pass
"""

import logging
from typing import Dict, Any, List, Callable, Optional
import asyncio
from datetime import datetime

from server.tools import Action, execute, BlockedActionError, ToolExecutionError

logger = logging.getLogger(__name__)


async def fill_batch(
    browser_session,
    gemini_client,
    openclaw_client,
    config: Dict[str, Any],
    ws_update_callback: Callable,
    action_logger
) -> Dict[str, Any]:
    """
    Fill loop - main agent orchestration for Fill button.
    
    Flow:
    1. Screenshot current page
    2. Extract data via Gemini
    3. Plan actions
    4. Execute actions with status updates
    5. Verification pass
    6. Report complete or flag incomplete
    
    Args:
        browser_session: Playwright browser session
        gemini_client: Gemini API client
        openclaw_client: OpenClaw element resolver
        config: Configuration dict
        ws_update_callback: WebSocket status update function
        action_logger: Action logging handler
        
    Returns:
        Dict with completion status
    """
    
    try:
        # 1. Take initial screenshot
        await ws_update_callback({"type": "status", "message": "Taking screenshot..."})
        screenshot_b64 = await browser_session.screenshot()
        
        # 2. Fetch document URL(s) from current batch page
        doc_urls = await browser_session.get_document_urls()
        
        # 3. Extract data via Gemini Vision
        await ws_update_callback({"type": "status", "message": "Extracting data with Gemini..."})
        
        extraction = await gemini_client.extract(
            screenshot_b64=screenshot_b64,
            doc_urls=doc_urls
        )
        
        doc_type = extraction["doc_type"]
        confidence = extraction["confidence"]
        flags = extraction.get("flags", [])
        
        await ws_update_callback({
            "type": "status",
            "message": f"Detected: {doc_type} ({confidence}%)"
        })
        
        # If flagged incomplete during extraction, stop here
        if extraction.get("incomplete_reason"):
            await ws_update_callback({
                "type": "incomplete",
                "reason": extraction["incomplete_reason"],
                "flags": flags
            })
            return {
                "status": "incomplete",
                "reason": extraction["incomplete_reason"],
                "flags": flags
            }
        
        # 4. Plan actions from extraction
        actions = await gemini_client.plan_actions(extraction)
        
        await ws_update_callback({
            "type": "status",
            "message": f"Planned {len(actions)} actions"
        })
        
        # 5. Execute actions
        for idx, action in enumerate(actions, 1):
            action.seq = idx
            
            await ws_update_callback({
                "type": "status",
                "message": f"[{idx}/{len(actions)}] {action.name}..."
            })
            
            try:
                # Resolve element if needed (OpenClaw fallback)
                if action.element_description:
                    element = await openclaw_client.resolve(action.element_description)
                    action.selector_used = element.selector
                    action.openclaw_fallback = element.used_openclaw
                
                # Execute action
                result = await execute(
                    action=action,
                    browser_session=browser_session,
                    config=config,
                    ws_update_callback=ws_update_callback
                )
                
                # Log action
                await action_logger.log_action(action)
                
                # Small delay between actions
                await asyncio.sleep(0.3)
            
            except (BlockedActionError, ToolExecutionError) as e:
                logger.error(f"Action failed: {action.name} - {e}")
                action.success = False
                action.error = str(e)
                await action_logger.log_action(action)
                
                # Continue with remaining actions even if one fails
                await ws_update_callback({
                    "type": "warning",
                    "message": f"Action failed: {action.name} - {e}"
                })
        
        # 6. Post-fill screenshot
        await ws_update_callback({"type": "status", "message": "Verifying filled fields..."})
        post_screenshot = await browser_session.screenshot()
        
        # 7. Verification pass
        verification = await gemini_client.verify(post_screenshot)
        
        red_fields = verification.get("red_fields", [])
        ok = verification.get("ok", False)
        
        # 8. Report complete
        if ok and len(red_fields) == 0:
            await ws_update_callback({
                "type": "complete",
                "doc_type": doc_type,
                "red_fields": [],
                "flags": flags
            })
            
            return {
                "status": "complete",
                "doc_type": doc_type,
                "red_fields": [],
                "flags": flags
            }
        else:
            # Has red fields - report but still complete
            await ws_update_callback({
                "type": "complete",
                "doc_type": doc_type,
                "red_fields": red_fields,
                "flags": flags
            })
            
            return {
                "status": "complete_with_warnings",
                "doc_type": doc_type,
                "red_fields": red_fields,
                "flags": flags
            }
    
    except Exception as e:
        logger.error(f"Fill batch error: {e}")
        await ws_update_callback({
            "type": "error",
            "message": str(e)
        })
        return {
            "status": "error",
            "error": str(e)
        }


async def open_next_batch(
    browser_session,
    config: Dict[str, Any],
    ws_update_callback: Callable
) -> Dict[str, Any]:
    """
    Next loop - open oldest unassigned batch.
    
    Flow:
    1. Navigate to batch list view
    2. Parse all visible batches
    3. Filter: status != "in_progress" AND assigned_to == null
    4. Sort by created_at ASC (oldest first)
    5. Click top result
    6. Report opened batch
    
    Args:
        browser_session: Playwright browser session
        config: Configuration dict
        ws_update_callback: WebSocket status update function
        
    Returns:
        Dict with opened batch info
    """
    
    try:
        # 1. Navigate to batch list
        await ws_update_callback({"type": "status", "message": "Loading batch list..."})
        
        batch_list_url = f"{config['EPHESOFT_URL']}/batches"
        await browser_session.navigate(batch_list_url)
        
        # 2. Parse visible batches
        await ws_update_callback({"type": "status", "message": "Parsing batches..."})
        
        batches = await browser_session.parse_batch_list()
        
        # 3. Filter
        available_batches = [
            b for b in batches
            if b["status"] != "in_progress" and b["assigned_to"] is None
        ]
        
        if not available_batches:
            await ws_update_callback({
                "type": "error",
                "message": "No available batches found"
            })
            return {
                "status": "no_batches",
                "message": "No unassigned batches available"
            }
        
        # 4. Sort by created_at (oldest first)
        available_batches.sort(key=lambda b: b["created_at"])
        
        oldest_batch = available_batches[0]
        
        # 5. Open batch
        await ws_update_callback({
            "type": "status",
            "message": f"Opening batch {oldest_batch['id']}..."
        })
        
        await browser_session.open_batch(oldest_batch["id"])
        
        # 6. Report success
        await ws_update_callback({
            "type": "batch_opened",
            "batch_id": oldest_batch["id"],
            "created_at": oldest_batch["created_at"]
        })
        
        return {
            "status": "opened",
            "batch_id": oldest_batch["id"],
            "created_at": oldest_batch["created_at"]
        }
    
    except Exception as e:
        logger.error(f"Open next batch error: {e}")
        await ws_update_callback({
            "type": "error",
            "message": str(e)
        })
        return {
            "status": "error",
            "error": str(e)
        }
