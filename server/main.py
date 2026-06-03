"""
FastAPI server with WebSocket endpoint for Ephesoft Copilot.

Handles:
- WebSocket connections from Electron renderer
- Fill and Next command routing
- Status updates during execution
"""

import logging
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import json
from typing import Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Ephesoft Copilot Server")

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
        await websocket.send_json({
            "type": "error",
            "message": str(e)
        })


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
        
        # TODO: Wire to agent.py fill_loop()
        # from server.agent import fill_batch
        # result = await fill_batch(ws_update)
        
        # Placeholder response
        await ws_update({
            "type": "status",
            "message": "Taking screenshot..."
        })
        
        await ws_update({
            "type": "status",
            "message": "Extracting data with Gemini..."
        })
        
        await ws_update({
            "type": "complete",
            "doc_type": "invoice",
            "red_fields": [],
            "flags": []
        })
        
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
    2. Parse batch data
    3. Filter and sort
    4. Open oldest unassigned batch
    5. Report opened batch info
    """
    
    async def ws_update(update: dict):
        """Send status update to client."""
        await websocket.send_json(update)
    
    try:
        await ws_update({"type": "status", "message": "Loading batch list..."})
        
        # TODO: Wire to agent.py next_loop()
        # from server.agent import open_next_batch
        # result = await open_next_batch(ws_update)
        
        # Placeholder response
        await ws_update({
            "type": "batch_opened",
            "batch_id": "EPH-00234",
            "created_at": "2024-03-15T09:00:00Z"
        })
        
        logger.info("Next operation complete")
    
    except Exception as e:
        logger.error(f"Next error: {e}")
        await ws_update({
            "type": "error",
            "message": str(e)
        })


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
