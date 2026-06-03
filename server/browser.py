"""
Playwright browser session management.

Handles:
- Persistent browser context (survives restarts)
- Screenshot capture
- Element interaction (fill, click, select)
- Page parsing (batch list, field state)
- Mock mode support
"""

import logging
from typing import Optional, Dict, Any, List
import base64
from pathlib import Path
from playwright.async_api import async_playwright, Browser, BrowserContext, Page

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
    
    async def fill(self, selector: str, value: str):
        """Fill input field."""
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        await self.page.fill(selector, value)
        logger.debug(f"Filled {selector} = {value}")
    
    async def click(self, selector: str):
        """Click element."""
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        await self.page.click(selector)
        logger.debug(f"Clicked {selector}")
    
    async def select(self, selector: str, value: str):
        """Select dropdown option."""
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        await self.page.select_option(selector, value)
        logger.debug(f"Selected {selector} = {value}")
    
    async def get_document_urls(self) -> List[str]:
        """
        Extract document URL(s) from current Ephesoft batch page.
        
        Returns:
            List of document URLs
        """
        # TODO: Implement actual parsing based on Ephesoft DOM structure
        # This is a placeholder
        return []
    
    async def parse_batch_list(self) -> List[Dict[str, Any]]:
        """
        Parse batch list page.
        
        Returns:
            List of batch dicts with id, created_at, status, assigned_to
        """
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        # TODO: Implement actual parsing based on Ephesoft batch list structure
        # This is a placeholder
        return []
    
    async def open_batch(self, batch_id: str):
        """Open a specific batch by ID."""
        if not self.page:
            raise RuntimeError("Browser session not started")
        
        # TODO: Implement actual batch opening logic
        # Placeholder: assume clicking a link/button with batch ID
        logger.info(f"Opening batch: {batch_id}")
