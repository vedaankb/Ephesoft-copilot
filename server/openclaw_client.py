"""
OpenClaw element resolution wrapper.

Uses Gemini 1.5 Pro to resolve natural language element descriptions
into valid CSS selectors based on the current page HTML.
"""

import logging
import re
from typing import Dict, Any, Optional
import google.generativeai as genai
import keyring

logger = logging.getLogger(__name__)


def clean_html(html: str) -> str:
    """
    Clean HTML to focus on visible form area and reduce token size.
    Strips head, scripts, styles, nav, and SVGs, and collapses whitespace.
    """
    if not html:
        return ""
    
    # Remove head, script, style, nav, svg tags and their contents
    html = re.sub(r'<head\b[^>]*>.*?</head>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<style\b[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<nav\b[^>]*>.*?</nav>', '', html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r'<svg\b[^>]*>.*?</svg>', '', html, flags=re.DOTALL | re.IGNORECASE)
    
    # Collapse multiple whitespaces and newlines
    html = re.sub(r'\s+', ' ', html)
    
    return html.strip()


class OpenClawClient:
    """Client for OpenClaw element resolution using Gemini."""
    
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        
        # Try to load API key from OS keychain first, then fallback to config
        self.api_key = None
        try:
            self.api_key = keyring.get_password("ephesoft-copilot", "GEMINI_API_KEY")
        except Exception as e:
            logger.warning(f"Failed to read from keyring: {e}")
            
        if not self.api_key:
            self.api_key = config.get("GEMINI_API_KEY")
            
        if not self.api_key:
            logger.warning("GEMINI_API_KEY not found in keyring or config.json")
        else:
            genai.configure(api_key=self.api_key)
            
        # Use gemini-1.5-pro for complex HTML reasoning
        self.model_name = 'gemini-1.5-pro'
        self.model = genai.GenerativeModel(self.model_name)
    
    async def resolve(self, description: str, page_html: str) -> str:
        """
        Resolve a natural language description to a CSS selector using Gemini.
        
        Args:
            description: Natural language description of the target element
            page_html: Current raw HTML content of the page
            
        Returns:
            A valid CSS selector string
        """
        if not self.api_key:
            raise ValueError("GEMINI_API_KEY is not configured. Cannot resolve elements.")
            
        # Clean and trim HTML to focus on relevant elements and stay within token budget
        cleaned = clean_html(page_html)
        trimmed_html = cleaned[:15000]
        
        prompt = f"""You are an HTML element resolver.
Return ONLY a valid CSS selector that uniquely identifies the described element.
No explanation. No markdown. Just the selector string.

Description: {description}

HTML:
{trimmed_html}"""
        
        logger.info(f"Resolving element with OpenClaw: '{description}'")
        
        try:
            # Call Gemini API asynchronously
            response = await self.model.generate_content_async(prompt)
            selector = response.text.strip()
            
            # Clean up any markdown code block formatting if the model returned it
            if selector.startswith("```"):
                # Strip ```css or ```
                selector = re.sub(r'^```[a-zA-Z]*\s*', '', selector)
                selector = re.sub(r'\s*```$', '', selector)
                selector = selector.strip()
                
            logger.info(f"OpenClaw resolved '{description}' -> '{selector}'")
            return selector
            
        except Exception as e:
            logger.error(f"OpenClaw resolution failed for '{description}': {e}")
            raise RuntimeError(f"OpenClaw failed to resolve element: {e}")
