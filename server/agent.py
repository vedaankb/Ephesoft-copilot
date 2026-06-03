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
from server.sop import should_stop_fill

logger = logging.getLogger(__name__)


async def fill_batch(
    channel,
    gemini_client,
    openclaw_client,
    config: Dict[str, Any],
    ws_update_callback: Callable,
    action_logger,
) -> Dict[str, Any]:
    """
    Fill loop - main agent orchestration for Fill button.
    
    Flow:
    1. Screenshot current page
    2. Fetch document raw bytes
    3. Extract data via Gemini
    4. Plan actions
    5. Execute actions with status updates (using OpenClaw for resolution)
    6. Verification pass
    7. Report complete or flag incomplete
    """
    
    try:
        # 1. Take initial screenshot via the extension
        await ws_update_callback({"type": "status", "message": "Taking screenshot..."})
        screenshot_b64 = await channel.screenshot()

        # 2. Document bytes — for now we extract from the screenshot only.
        # When we know how Ephesoft serves the doc PDF, we'll fetch it via the
        # extension. Sending an empty bytes string here is fine; the screenshot
        # is the primary source for extraction.
        doc_bytes = b""
        
        # 3. Extract data via Gemini Vision
        await ws_update_callback({"type": "status", "message": "Extracting data with Gemini..."})
        
        extraction = await gemini_client.extract(
            screenshot_b64=screenshot_b64,
            doc_bytes=doc_bytes
        )
        
        doc_type = extraction.get("doc_type", "invoice")
        confidence = extraction.get("confidence", 0)
        flags = extraction.get("flags", [])
        
        await ws_update_callback({
            "type": "status",
            "message": f"Detected: {doc_type} ({confidence}%)"
        })
        
        # If flags are present, report them to the panel
        if flags:
            await ws_update_callback({
                "type": "status",
                "message": f"Warnings detected: {', '.join(flags)}"
            })
            # Send flags explicitly to the panel
            await ws_update_callback({
                "type": "warning",
                "message": f"Flags triggered: {', '.join(flags)}"
            })
        
        # SOP: stop before any DOM fill when incomplete (three Wombat reasons or doc_type incomplete)
        if should_stop_fill(extraction):
            reason = extraction.get("incomplete_reason") or "Missing Information"
            await ws_update_callback({
                "type": "incomplete",
                "reason": reason,
                "flags": flags
            })
            
            # Save final state in action logger
            action_logger.set_doc_type(doc_type)
            action_logger.set_completion(red_fields=[], flags=flags, human_edit=False)
            await action_logger.save()
            
            return {
                "status": "incomplete",
                "reason": reason,
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
            
            # Construct user-friendly status message
            status_msg = f"Executing {action.name}..."
            if action.name == "set_document_type":
                status_msg = f"Setting document type to {action.parameters['doc_type']}..."
            elif action.name == "fill_field":
                status_msg = f"Filling field {action.parameters['field_name']}..."
            elif action.name == "clear_table":
                status_msg = "Clearing line items table..."
            elif action.name == "insert_table_row":
                status_msg = f"Adding line item: {action.parameters['description']}..."
                
            await ws_update_callback({
                "type": "status",
                "message": f"[{idx}/{len(actions)}] {status_msg}"
            })
            
            try:
                # Execute action using OpenClaw resolution inside tools.py
                await execute(
                    action=action,
                    channel=channel,
                    openclaw=openclaw_client,
                    ws_update_callback=ws_update_callback,
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
                
                await ws_update_callback({
                    "type": "warning",
                    "message": f"Action failed: {action.name} - {e}"
                })
        
        # 6. Post-fill screenshot
        await ws_update_callback({"type": "status", "message": "Verifying filled fields..."})
        post_screenshot = await channel.screenshot()
        
        # 7. Verification pass
        verification = await gemini_client.verify(post_screenshot)
        
        red_fields = verification.get("red_fields", [])
        ok = verification.get("ok", False)
        
        # 8. Report complete
        await ws_update_callback({
            "type": "complete",
            "doc_type": doc_type,
            "red_fields": red_fields,
            "flags": flags
        })
        
        # Save final state in action logger
        action_logger.set_doc_type(doc_type)
        action_logger.set_completion(red_fields=red_fields, flags=flags, human_edit=False)
        await action_logger.save()
        
        return {
            "status": "complete",
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
    channel,
    openclaw_client,
    config: Dict[str, Any],
    ws_update_callback: Callable,
) -> Dict[str, Any]:
    """
    Next loop — assumes the user is already on the batch list page in their tab.

    Flow:
    1. Read the page HTML via the extension
    2. Ask Gemini to extract structured batches from it
    3. Filter to status != "in_progress" AND assigned_to == null
    4. Sort by created_at ASC (oldest first)
    5. Use OpenClaw to find a click target for the top batch and click it
    6. Report opened batch
    """

    try:
        await ws_update_callback({"type": "status", "message": "Reading batch list from page..."})
        batches = await channel.parse_batch_list(openclaw_client)
        
        # 3. Filter
        available_batches = [
            b for b in batches
            if b.get("status") != "in_progress" and b.get("assigned_to") is None
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
        available_batches.sort(key=lambda b: b.get("created_at", ""))
        
        oldest_batch = available_batches[0]
        batch_id = oldest_batch["id"]
        
        # 5. Open batch
        await ws_update_callback({
            "type": "status",
            "message": f"Opening batch {batch_id}..."
        })
        
        await channel.open_batch(batch_id, openclaw_client)
        
        # 6. Report success
        await ws_update_callback({
            "type": "batch_opened",
            "batch_id": batch_id,
            "created_at": oldest_batch.get("created_at")
        })
        
        return {
            "status": "opened",
            "batch_id": batch_id,
            "created_at": oldest_batch.get("created_at")
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
