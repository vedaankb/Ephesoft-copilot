"""
FastAPI server with WebSocket endpoint for Ephesoft Copilot.

Handles:
- WebSocket connections from Electron renderer
- Fill and Next command routing
- Status updates during execution
- Browser session, Gemini, and OpenClaw lifecycles
"""

import logging
import json
from pathlib import Path
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from server.browser import BrowserSession
from server.gemini_client import GeminiClient
from server.openclaw_client import OpenClawClient
from server.action_logger import ActionLogger

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
config = {}
browser = None
gemini = None
openclaw = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage the lifecycle of the browser session and API clients."""
    global config, browser, gemini, openclaw
    
    logger.info("Starting up Ephesoft Copilot Server...")
    
    # Load config
    config_path = Path.cwd() / "config.json"
    if config_path.exists():
        try:
            with open(config_path) as f:
                config = json.load(f)
            logger.info("Loaded config.json successfully")
        except Exception as e:
            logger.error(f"Failed to parse config.json: {e}")
            config = {}
    else:
        logger.warning("config.json not found, using empty config")
        config = {}
        
    # Initialize components
    browser = BrowserSession(config)
    gemini = GeminiClient(config)
    openclaw = OpenClawClient(config)
    
    # Start browser session
    await browser.start()
    
    yield
    
    # Clean up browser session
    logger.info("Shutting down Ephesoft Copilot Server...")
    if browser:
        await browser.close()


app = FastAPI(title="Ephesoft Copilot Server", lifespan=lifespan)

# Enable CORS for Electron renderer
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectionManager:
    """Manage WebSocket connections."""
    
    def __init__(self):
        self.active_connections: list[WebSocket] = []
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("Client connected")
    
    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)
        logger.info("Client disconnected")
    
    async def send_message(self, websocket: WebSocket, message: dict):
        await websocket.send_json(message)
    
    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            await connection.send_json(message)


manager = ConnectionManager()


@app.get("/")
async def root():
    """Health check endpoint."""
    return {"status": "ok", "service": "ephesoft-copilot"}


@app.get("/health")
async def health():
    """Health check for monitoring."""
    return {"status": "healthy"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for Electron renderer.
    
    Message format:
    {
        "type": "fill" | "next",
        "payload": {...}
    }
    """
    await manager.connect(websocket)
    
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            message_type = message.get("type")
            payload = message.get("payload", {})
            
            logger.info(f"Received message: {message_type}")
            
            if message_type == "fill":
                await handle_fill(websocket, payload)
            elif message_type == "next":
                await handle_next(websocket, payload)
            elif message_type == "human_edit":
                await handle_human_edit(websocket, payload)
            else:
                await websocket.send_json({
                    "type": "error",
                    "message": f"Unknown message type: {message_type}"
                })
    
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
        except Exception:
            pass


async def handle_fill(websocket: WebSocket, payload: dict):
    """
    Handle Fill button click.
    
    Flow:
    1. Take screenshot
    2. Extract data via Gemini
    3. Plan actions
    4. Execute actions with status updates
    5. Verify and report complete
    """
    
    async def ws_update(update: dict):
        """Send status update to client."""
        await websocket.send_json(update)
    
    try:
        await ws_update({"type": "status", "message": "Starting fill operation..."})
        
        # Create action logger for this fill session
        action_logger = ActionLogger()
        
        # Try to extract batch ID from the page heading or URL
        try:
            heading = await browser.page.locator("h1").first.text_content()
            if "Batch:" in heading:
                batch_id = heading.split("Batch:")[1].strip()
                action_logger.set_batch_id(batch_id)
            else:
                action_logger.set_batch_id("UNKNOWN")
        except Exception:
            action_logger.set_batch_id("UNKNOWN")
            
        from server.agent import fill_batch
        await fill_batch(
            browser_session=browser,
            gemini_client=gemini,
            openclaw_client=openclaw,
            config=config,
            ws_update_callback=ws_update,
            action_logger=action_logger
        )
        
        logger.info("Fill operation complete")
    
    except Exception as e:
        logger.error(f"Fill error: {e}")
        await ws_update({
            "type": "error",
            "message": str(e)
        })


async def handle_next(websocket: WebSocket, payload: dict):
    """
    Handle Next button click.
    
    Flow:
    1. Navigate to batch list
    2. Parse batch data using Gemini
    3. Filter and sort
    4. Open oldest unassigned batch using OpenClaw
    5. Report opened batch info
    """
    
    async def ws_update(update: dict):
        """Send status update to client."""
        await websocket.send_json(update)
    
    try:
        await ws_update({"type": "status", "message": "Starting next batch operation..."})
        
        from server.agent import open_next_batch
        await open_next_batch(
            browser_session=browser,
            openclaw_client=openclaw,
            config=config,
            ws_update_callback=ws_update
        )
        
        logger.info("Next operation complete")
    
    except Exception as e:
        logger.error(f"Next error: {e}")
        await ws_update({
            "type": "error",
            "message": str(e)
        })


async def handle_human_edit(websocket: WebSocket, payload: dict):
    """Handle human_edit flag update for the most recent session log."""
    try:
        from server.action_logger import ActionLogger
        recent_logs = ActionLogger.get_recent_sessions(limit=1)
        if recent_logs:
            log_path = recent_logs[0]
            log_data = ActionLogger.load_session(log_path)
            log_data["human_edit"] = True
            
            # Save it back
            with open(log_path, 'w') as f:
                json.dump(log_data, f, indent=2)
                
            logger.info(f"Updated human_edit to True for log: {log_path}")
            await websocket.send_json({
                "type": "status",
                "message": "✓ Logged human edit for quality metrics"
            })
    except Exception as e:
        logger.error(f"Failed to log human edit: {e}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
