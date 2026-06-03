"""
Playwright browser session management.

Handles:
- Persistent browser context (survives restarts)
- Screenshot capture
- Element interaction (fill, click, select)
- Page parsing (batch list, field state) using OpenClaw/Gemini
- Mock mode support
"""

import logging
import base64
import re
import json
from pathlib import Path
from typing import Optional, Dict, Any, List
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

from server.openclaw_client import clean_html

logger = logging.getLogger(__name__)


class BrowserSession:
    """Persistent Playwright browser session."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.playwright = None
        self.browser: Optional[Browser] = None
        self.context: Optional[BrowserContext] = None
        self.page: Optional[Page] = None
        self.mock_mode = config.get("MOCK", False)
        self._started = False
    
    async def ensure_started(self):
        """Start Playwright on first use so the API/WebSocket can accept connections immediately."""
        if not self._started:
            await self.start()
            self._started = True
    
    async def start(self):
        """Initialize browser session."""
        logger.info("Starting browser session...")
        
        self.playwright = await async_playwright().start()
        
        # Launch persistent context
        browser_data_dir = Path.cwd() / "browser-data"
        browser_data_dir.mkdir(exist_ok=True)
        
        self.context = await self.playwright.chromium.launch_persistent_context(
            str(browser_data_dir),
            headless=False,  # Visible for debugging
            viewport={"width": 1280, "height": 800},
            args=["--disable-blink-features=AutomationControlled"]
        )
        
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        
        # Navigate to initial page
        if self.mock_mode:
            fixture_path = Path.cwd() / "fixtures" / "field_view.html"
            await self.page.goto(f"file://{fixture_path}")
            logger.info("Mock mode: loaded fixtures/field_view.html")
        else:
            ephesoft_url = self.config.get("EPHESOFT_URL")
            if ephesoft_url:
                await self.page.goto(ephesoft_url)
                logger.info(f"Navigated to {ephesoft_url}")
        
        logger.info("Browser session started")
    
    async def close(self):
        """Close browser session."""
        if self.context:
            await self.context.close()
        if self.playwright:
            await self.playwright.stop()
        logger.info("Browser session closed")
    
    async def screenshot(self, path: Optional[str] = None) -> str:
        """
        Take screenshot of current page.
        
        Args:
            path: Optional file path to save screenshot
            
        Returns:
            Base64-encoded PNG
        """
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        screenshot_bytes = await self.page.screenshot(full_page=False)
        
        if path:
            # Ensure parent directory exists
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            with open(path, "wb") as f:
                f.write(screenshot_bytes)
            logger.info(f"Screenshot saved: {path}")
        
        return base64.b64encode(screenshot_bytes).decode("utf-8")
    
    async def navigate(self, url: str):
        """Navigate to URL."""
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        await self.page.goto(url)
        logger.info(f"Navigated to {url}")
        
    async def navigate_to_batch_list(self):
        """Navigate to the batch list page."""
        if self.mock_mode:
            fixture_path = Path.cwd() / "fixtures" / "batch_list.html"
            await self.navigate(f"file://{fixture_path}")
            logger.info("Mock mode: loaded fixtures/batch_list.html")
        else:
            ephesoft_url = self.config.get("EPHESOFT_URL")
            if ephesoft_url:
                batch_list_url = f"{ephesoft_url.rstrip('/')}/batches"
                await self.navigate(batch_list_url)
                logger.info(f"Navigated to batch list: {batch_list_url}")
                
    async def fetch_doc_bytes(self) -> bytes:
        """
        Fetch raw bytes of the document being processed.
        In mock mode, returns dummy PDF bytes or reads a sample PDF if available.
        """
        if self.mock_mode:
            sample_dir = Path.cwd() / "fixtures" / "sample_docs"
            sample_pdfs = list(sample_dir.glob("*.pdf"))
            if sample_pdfs:
                with open(sample_pdfs[0], "rb") as f:
                    return f.read()
            return b"%PDF-1.4 mock pdf content"
            
        # In live mode, we would extract the document URL from the page and fetch it
        try:
            # Look for iframe or image sources of the document viewer
            # For now, return a placeholder
            return b"%PDF-1.4 live pdf content placeholder"
        except Exception as e:
            logger.error(f"Failed to fetch document bytes: {e}")
            return b""
            
    async def parse_batch_list(self, openclaw) -> List[Dict[str, Any]]:
        """
        Parse the batch list page to extract all visible batches.
        Uses Gemini to parse the HTML and return a structured list.
        """
        if not self.page:
            raise RuntimeError("Browser session not started")
            
        html = await self.page.content()
        cleaned = clean_html(html)
        trimmed_html = cleaned[:15000]
        
        prompt = """You are an HTML table parser.
Extract all visible batches from the batch list HTML.
Return ONLY a valid JSON list of objects, where each object has the following keys:
- "id": string (the batch ID, e.g., "EPH-00231")
- "created_at": string (ISO 8601 format or raw date string, e.g., "2024-03-15T08:00:00Z")
- "status": string ("available" or "in_progress")
- "assigned_to": string or null (username or email of the assigned user, or null if unassigned)

No explanation. No markdown. Just the JSON array.

HTML:
""" + trimmed_html

        try:
            # Call Gemini API to parse the HTML
            response = await openclaw.model.generate_content_async(prompt)
            text = response.text.strip()
            
            # Clean markdown formatting if any
            if text.startswith("```"):
                text = re.sub(r'^```[a-zA-Z]*\s*', '', text)
                text = re.sub(r'\s*```$', '', text)
                text = text.strip()
                
            batches = json.loads(text)
            logger.info(f"Parsed {len(batches)} batches from batch list")
            return batches
        except Exception as e:
            logger.error(f"Failed to parse batch list: {e}")
            return []
            
    async def open_batch(self, batch_id: str, openclaw):
        """Open a specific batch by ID using OpenClaw to find the clickable element."""
        if not self.page:
            raise RuntimeError("Browser session not started")
            
        html = await self.page.content()
        selector = await openclaw.resolve(
            description=f"link or button to open batch {batch_id}",
            page_html=html
        )
        
        await self.page.click(selector)
        logger.info(f"Opened batch: {batch_id}")
