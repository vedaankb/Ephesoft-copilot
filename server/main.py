"""
FastAPI server for Ephesoft Copilot.

Wires:
- /ws/panel       — Electron renderer talks to the agent (Fill / Next / human_edit)
- /ws/extension   — Browser extension service worker forwards DOM commands
- /api/settings   — read/save Gemini API key (in OS keychain)
- /api/test_key   — small live API call to verify the key
- /mock/*         — local mock pages for end-to-end testing without Ephesoft
"""

import logging
import json
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from server.extension_channel import ExtensionChannel, ExtensionNotConnected
from server.gemini_client import GeminiClient
from server.openclaw_client import OpenClawClient
from server.action_logger import ActionLogger
from server.credentials import (
    load_gemini_api_key,
    save_gemini_api_key,
    clear_gemini_api_key,
    test_gemini_api_key,
)
from server.paths import get_app_root, resource_path

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global runtime state
state = {
    "config": {},
    "channel": None,         # type: Optional[ExtensionChannel]
    "gemini": None,          # type: Optional[GeminiClient]
    "openclaw": None,        # type: Optional[OpenClawClient]
    "panel_sockets": [],     # type: list[WebSocket]
}


def _load_config() -> dict:
    cfg_path = get_app_root() / "config.json"
    if cfg_path.exists():
        try:
            with open(cfg_path) as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to parse config.json: {e}")
    return {}


def _reload_clients():
    """Re-instantiate Gemini + OpenClaw with the latest API key/config."""
    cfg = state["config"]
    state["gemini"] = GeminiClient(cfg)
    state["openclaw"] = OpenClawClient(cfg)
    logger.info("Reloaded Gemini + OpenClaw clients")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting Ephesoft Copilot server...")
    state["config"] = _load_config()
    state["channel"] = ExtensionChannel()
    _reload_clients()
    logger.info("Server ready")
    yield
    logger.info("Server shutting down")


app = FastAPI(title="Ephesoft Copilot Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- health ----------

@app.get("/")
async def root():
    return {"status": "ok", "service": "ephesoft-copilot"}


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "extension_connected": state["channel"].is_connected() if state["channel"] else False,
        "has_api_key": bool(load_gemini_api_key(state["config"])),
    }


# ---------- settings ----------

class SettingsIn(BaseModel):
    api_key: Optional[str] = None
    model: Optional[str] = None


@app.get("/api/settings")
async def get_settings():
    cfg = state["config"]
    key = load_gemini_api_key(cfg)
    return {
        "has_api_key": bool(key),
        "key_preview": (key[:6] + "…" + key[-4:]) if key and len(key) > 12 else None,
        "model": cfg.get("GEMINI_MODEL", "gemini-3.1-pro-preview"),
    }


@app.post("/api/settings")
async def update_settings(payload: SettingsIn):
    if payload.api_key is not None:
        if payload.api_key == "":
            clear_gemini_api_key()
        else:
            try:
                save_gemini_api_key(payload.api_key)
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
    if payload.model:
        state["config"]["GEMINI_MODEL"] = payload.model

    _reload_clients()
    return {"ok": True}


@app.post("/api/test_key")
async def test_key(payload: SettingsIn):
    key = (payload.api_key or "").strip() or load_gemini_api_key(state["config"])
    if not key:
        raise HTTPException(status_code=400, detail="No API key supplied or stored")
    result = await test_gemini_api_key(key)
    if not result["ok"]:
        return JSONResponse(status_code=400, content=result)
    return result


# ---------- mock pages (open these as a tab to test without real Ephesoft) ----------

@app.get("/mock/field_view")
async def mock_field_view():
    return FileResponse(resource_path("fixtures", "field_view.html"))


@app.get("/mock/batch_list")
async def mock_batch_list():
    return FileResponse(resource_path("fixtures", "batch_list.html"))


# ---------- panel WebSocket ----------

@app.websocket("/ws/panel")
async def ws_panel(websocket: WebSocket):
    await websocket.accept()
    state["panel_sockets"].append(websocket)
    logger.info("Panel connected")

    async def ws_update(update: dict):
        try:
            await websocket.send_json(update)
        except Exception:
            pass

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            mtype = message.get("type")
            payload = message.get("payload", {})
            logger.info(f"Panel message: {mtype}")

            if mtype == "fill":
                await _handle_fill(ws_update)
            elif mtype == "next":
                await _handle_next(ws_update)
            elif mtype == "human_edit":
                await _handle_human_edit(ws_update)
            elif mtype == "ping":
                await ws_update({"type": "pong"})
            else:
                await ws_update({"type": "error", "message": f"Unknown type: {mtype}"})
    except WebSocketDisconnect:
        logger.info("Panel disconnected")
    except Exception as e:
        logger.error(f"Panel WS error: {e}")
    finally:
        if websocket in state["panel_sockets"]:
            state["panel_sockets"].remove(websocket)


# Backwards-compatibility alias for the original /ws path
@app.websocket("/ws")
async def ws_panel_alias(websocket: WebSocket):
    await ws_panel(websocket)


# ---------- extension WebSocket ----------

@app.websocket("/ws/extension")
async def ws_extension(websocket: WebSocket):
    channel: ExtensionChannel = state["channel"]
    await channel.attach(websocket)

    # Tell any connected panels the extension is online
    await _broadcast_panel({"type": "extension_status", "connected": True})

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                logger.warning(f"Extension sent non-JSON: {raw[:120]}")
                continue
            await channel.handle_incoming(msg)
    except WebSocketDisconnect:
        logger.info("Extension disconnected")
    except Exception as e:
        logger.error(f"Extension WS error: {e}")
    finally:
        channel.detach(websocket)
        await _broadcast_panel({"type": "extension_status", "connected": False})


async def _broadcast_panel(message: dict):
    for ws in list(state["panel_sockets"]):
        try:
            await ws.send_json(message)
        except Exception:
            pass


# ---------- handlers ----------

async def _handle_fill(ws_update):
    channel: ExtensionChannel = state["channel"]
    if not channel.is_connected():
        await ws_update({"type": "error", "message": "Browser extension is not connected. Open Ephesoft in Chrome and ensure the extension is loaded."})
        return

    if not state["gemini"] or not state["gemini"].api_key:
        await ws_update({"type": "error", "message": "Gemini API key is not configured. Open Settings and add your AIza... key."})
        return

    action_logger = ActionLogger()
    try:
        url = await channel.active_tab_url()
        action_logger.set_batch_id(url or "UNKNOWN")
    except Exception:
        action_logger.set_batch_id("UNKNOWN")

    from server.agent import fill_batch
    await fill_batch(
        channel=channel,
        gemini_client=state["gemini"],
        openclaw_client=state["openclaw"],
        config=state["config"],
        ws_update_callback=ws_update,
        action_logger=action_logger,
    )


async def _handle_next(ws_update):
    channel: ExtensionChannel = state["channel"]
    if not channel.is_connected():
        await ws_update({"type": "error", "message": "Browser extension is not connected."})
        return

    if not state["gemini"] or not state["gemini"].api_key:
        await ws_update({"type": "error", "message": "Gemini API key is not configured."})
        return

    from server.agent import open_next_batch
    await open_next_batch(
        channel=channel,
        openclaw_client=state["openclaw"],
        config=state["config"],
        ws_update_callback=ws_update,
    )


async def _handle_human_edit(ws_update):
    try:
        recent = ActionLogger.get_recent_sessions(limit=1)
        if not recent:
            await ws_update({"type": "status", "message": "No recent session to mark"})
            return
        log_path = recent[0]
        log_data = ActionLogger.load_session(log_path)
        log_data["human_edit"] = True
        with open(log_path, "w") as f:
            json.dump(log_data, f, indent=2)
        await ws_update({"type": "status", "message": "Logged human edit for quality metrics"})
    except Exception as e:
        logger.error(f"human_edit failed: {e}")
        await ws_update({"type": "error", "message": str(e)})


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
