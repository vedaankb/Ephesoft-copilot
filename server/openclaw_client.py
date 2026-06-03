"""
OpenClaw element resolution wrapper.

Uses Gemini 1.5 Pro to resolve natural language element descriptions
into valid CSS selectors based on the current page HTML.
"""

import logging
import re
from typing import Dict, Any, Optional
import google.generativeai as genai

from server.credentials import load_gemini_api_key, validate_gemini_api_key, configure_gemini

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
    
    async def resolve(self, description: str, page_html: str) -> str:
        """
        Resolve a natural language description to a CSS selector using Gemini.
        
        Args:
            description: Natural language description of the target element
            page_html: Current raw HTML content of the page
            
        Returns:
            A valid CSS selector string
        """
        if not self.api_key or not self.model:
            validate_gemini_api_key("")
            
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
            err = str(e)
            logger.error(f"OpenClaw resolution failed for '{description}': {e}")
            if "401" in err or "ACCESS_TOKEN" in err:
                raise RuntimeError(
                    "Gemini authentication failed (401). Fix GEMINI_API_KEY — see "
                    "https://aistudio.google.com/apikey"
                ) from e
            raise RuntimeError(f"OpenClaw failed to resolve element: {e}") from e
