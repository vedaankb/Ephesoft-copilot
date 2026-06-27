"""
Extension channel — replaces server/browser.py.

The browser DOM is now in the user's own Chrome tab, reached via a Chrome MV3
extension over a WebSocket. This class:
  - holds the active extension WebSocket connection
  - sends low-level commands (fill, click, select, get_html, screenshot, ...)
  - awaits the matching response by request id
  - rejects any commands not in the closed allowlist (defense-in-depth)

Same surface as the old BrowserSession so tools.py / agent.py do not care
that the DOM is now in another process.
"""

import asyncio
import json
import logging
import re
import uuid
from typing import Any, Dict, List, Optional

from fastapi import WebSocket

logger = logging.getLogger(__name__)


# Closed allowlist of low-level DOM commands the backend may send to the extension.
# Anything outside this list MUST be rejected before sending. The extension
# enforces the same list as defense-in-depth.
ALLOWED_CMDS = {
    "get_html",
    "screenshot",
    "capture_scroll_bundle",
    "fill",
    "click",
    "select",
    "fill_row",
    "exists",
    "active_tab_url",
}


class ExtensionNotConnected(Exception):
    """Raised when the extension WebSocket is not currently attached."""


class ExtensionChannel:
    """Routes commands to the connected browser extension service worker."""

    def __init__(self, request_timeout: float = 60.0):
        self._ws: Optional[WebSocket] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._timeout = request_timeout
        self._lock = asyncio.Lock()

    # ---------- connection lifecycle (called from /ws/extension handler) ----------

    async def attach(self, websocket: WebSocket) -> None:
        """Accept and register a new extension connection."""
        await websocket.accept()
        if self._ws is not None:
            try:
                await self._ws.close(code=4000, reason="replaced by new extension")
            except Exception:
                pass
        self._ws = websocket
        logger.info("Extension attached")

    def detach(self, websocket: WebSocket) -> None:
        """Drop the extension connection if it matches."""
        if self._ws is websocket:
            self._ws = None
            logger.info("Extension detached")
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ExtensionNotConnected("Extension disconnected"))
            self._pending.clear()

    def is_connected(self) -> bool:
        return self._ws is not None

    async def handle_incoming(self, message: dict) -> None:
        """Resolve a pending request when the extension replies."""
        req_id = message.get("id")
        if not req_id:
            logger.debug(f"Extension event without id: {message}")
            return
        fut = self._pending.pop(req_id, None)
        if fut and not fut.done():
            fut.set_result(message)

    # ---------- low-level send ----------

    async def _send_cmd(self, cmd: str, **params) -> Any:
        if cmd not in ALLOWED_CMDS:
            raise ValueError(
                f"Refusing to send disallowed cmd '{cmd}' to extension. "
                f"Allowed: {sorted(ALLOWED_CMDS)}"
            )
        if self._ws is None:
            raise ExtensionNotConnected(
                "Browser extension is not connected. Open Ephesoft in Chrome with the "
                "Ephesoft Copilot extension installed."
            )

        req_id = str(uuid.uuid4())
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req_id] = fut

        payload = {"id": req_id, "cmd": cmd, **params}
        try:
            async with self._lock:
                await self._ws.send_text(json.dumps(payload))
        except Exception as e:
            self._pending.pop(req_id, None)
            raise ExtensionNotConnected(f"Failed to send to extension: {e}")

        try:
            response = await asyncio.wait_for(fut, timeout=self._timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise TimeoutError(f"Extension did not respond to '{cmd}' within {self._timeout}s")

        if not response.get("ok", False):
            raise RuntimeError(f"Extension '{cmd}' failed: {response.get('error', 'unknown')}")

        return response.get("result")

    # ---------- high-level surface used by tools.py / agent.py ----------

    async def get_html(self) -> str:
        return await self._send_cmd("get_html") or ""

    async def screenshot(self) -> str:
        """Returns base64 PNG of the active tab."""
        return await self._send_cmd("screenshot") or ""

    async def capture_scroll_bundle(self, max_frames: int = 4) -> Dict[str, Any]:
        """Capture multiple viewport screenshots/html chunks while auto-scrolling."""
        result = await self._send_cmd("capture_scroll_bundle", max_frames=max_frames)
        if not isinstance(result, dict):
            return {"screenshots": [], "html_chunks": [], "meta": {}}
        result.setdefault("screenshots", [])
        result.setdefault("html_chunks", [])
        result.setdefault("meta", {})
        return result

    async def active_tab_url(self) -> str:
        return await self._send_cmd("active_tab_url") or ""

    async def fill(self, selector: str, value: str) -> None:
        await self._send_cmd("fill", selector=selector, value=value)

    async def click(self, selector: str) -> None:
        await self._send_cmd("click", selector=selector)

    async def select(self, selector: str, value: str) -> None:
        await self._send_cmd("select", selector=selector, value=value)

    async def fill_row(self, row_selector: str, values: List[str]) -> int:
        """Fill the fillable cells of a single row in order. Returns count filled."""
        result = await self._send_cmd("fill_row", row_selector=row_selector, values=values)
        try:
            return int(result)
        except (TypeError, ValueError):
            return 0

    async def exists(self, selector: str) -> int:
        """Return how many elements match the selector (0 = none)."""
        if not selector:
            return 0
        try:
            result = await self._send_cmd("exists", selector=selector)
            return int(result)
        except Exception:
            return 0

    # ---------- batch list parsing (uses Gemini, not extension) ----------

    async def parse_batch_list(self, openclaw) -> List[Dict[str, Any]]:
        """Ask Gemini to extract structured batch rows from whatever the page looks like."""
        from server.openclaw_client import clean_html

        html = await self.get_html()
        cleaned = clean_html(html)[:15000]

        if not cleaned:
            return []

        prompt = (
            "You are an HTML table parser for a document-processing portal "
            "(Ephesoft or similar). The user is viewing a list of batches.\n\n"
            "Return ONLY a JSON array. Each element MUST have:\n"
            "  - id: string (batch identifier)\n"
            "  - created_at: string (ISO 8601 if possible, else raw date string)\n"
            "  - status: string (use 'in_progress' if the batch is locked/being worked on, "
            "'available' otherwise)\n"
            "  - assigned_to: string|null (username/email or null if unassigned)\n\n"
            "No markdown. No explanation. Just the JSON array.\n\n"
            "HTML:\n" + cleaned
        )

        try:
            response = await openclaw.model.generate_content_async(
                prompt,
                generation_config={"response_mime_type": "application/json"},
            )
            text = (response.text or "").strip()
            if text.startswith("```"):
                text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
                text = re.sub(r"\s*```$", "", text).strip()
            batches = json.loads(text)
            if not isinstance(batches, list):
                return []
            logger.info(f"Parsed {len(batches)} batches from page")
            return batches
        except Exception as e:
            logger.error(f"Failed to parse batch list: {e}")
            return []

    async def open_batch(self, batch_id: str, openclaw) -> None:
        """
        Find a clickable element for the batch and click it, then verify the page
        actually changed. If nothing happened, retry with an alternate target
        before giving up — fixes "said opened but didn't" / wrong-row clicks.
        """
        before_url = ""
        try:
            before_url = await self.active_tab_url()
        except Exception:
            pass
        before_html = await self.get_html()

        descriptions = [
            f"the clickable link or button that opens the batch with id or text '{batch_id}' "
            f"(the open/view action in that specific row)",
            f"the table row containing '{batch_id}'",
            f"clickable row, link, or button to open batch {batch_id}",
        ]

        last_error: Optional[Exception] = None
        tried = set()
        for desc in descriptions:
            try:
                selector = await openclaw.resolve(description=desc, page_html=before_html)
            except Exception as e:
                last_error = e
                continue
            if not selector or selector in tried:
                continue
            tried.add(selector)

            try:
                await self.click(selector)
            except Exception as e:
                last_error = e
                continue

            # Give the page a moment, then verify something actually changed.
            await asyncio.sleep(1.0)
            try:
                after_url = await self.active_tab_url()
            except Exception:
                after_url = before_url
            after_html = await self.get_html()

            if after_url != before_url or after_html != before_html:
                logger.info(f"Opened batch via extension: {batch_id} (selector={selector})")
                return

            logger.warning(
                f"Click on '{selector}' did not change the page; trying an alternate target"
            )

        if last_error:
            raise RuntimeError(f"Could not open batch {batch_id}: {last_error}")
        raise RuntimeError(
            f"Clicked a candidate for batch {batch_id} but the page did not change. "
            "The batch link may not have been recognized."
        )
