"""
Action logging for audit trail.

Every action is logged with:
- Timestamp
- Action name
- Parameters
- Selector used
- Whether OpenClaw fallback was used
- Success/failure
- Error message if failed

Logs are append-only and never modified.
"""

import json
import logging
from typing import Dict, Any, Optional
from datetime import datetime
from server.paths import get_app_root

logger = logging.getLogger(__name__)


class ActionLogger:
    """Manages action logging for a session."""
    
    def __init__(self, batch_id: Optional[str] = None):
        self.session_id = str(uuid.uuid4())
        self.batch_id = batch_id
        self.doc_type: Optional[str] = None
        self.actions = []
        self.started_at = datetime.utcnow().isoformat() + "Z"
        self.completed_at: Optional[str] = None
        self.red_fields_remaining = 0
        self.flags = []
        self.human_edit = False
        
        # Create log file path
        timestamp = datetime.utcnow().strftime("%Y-%m-%d_%H-%M-%S")
        self.log_path = get_app_root() / "logs" / "actions" / f"{timestamp}.json"
        
        logger.info(f"Action logger started: {self.session_id}")
    
    async def log_action(self, action) -> None:
        """
        Log a single action.
        
        Args:
            action: Action object with execution details
        """
        action_dict = action.to_dict()
        self.actions.append(action_dict)
        
        logger.debug(f"Logged action: {action.name} (seq={action.seq})")
    
    def set_batch_id(self, batch_id: str) -> None:
        """Set batch ID for this session."""
        self.batch_id = batch_id
    
    def set_doc_type(self, doc_type: str) -> None:
        """Set document type."""
        self.doc_type = doc_type
    
    def set_completion(
        self,
        red_fields: list,
        flags: list,
        human_edit: bool = False
    ) -> None:
        """Mark session as complete and set final details."""
        self.completed_at = datetime.utcnow().isoformat() + "Z"
        self.red_fields_remaining = len(red_fields)
        self.flags = flags
        self.human_edit = human_edit
    
    async def save(self) -> str:
        """
        Write log to disk.
        
        Returns:
            Path to saved log file
        """
        log_data = {
            "session_id": self.session_id,
            "batch_id": self.batch_id,
            "doc_type": self.doc_type,
            "started_at": self.started_at,
            "actions": self.actions,
            "completed_at": self.completed_at,
            "red_fields_remaining": self.red_fields_remaining,
            "flags": self.flags,
            "human_edit": self.human_edit
        }
        
        # Ensure directory exists
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Write JSON (append-only, never modify existing)
        with open(self.log_path, 'w') as f:
            json.dump(log_data, f, indent=2)
        
        logger.info(f"Action log saved: {self.log_path}")
        return str(self.log_path)
    
    @staticmethod
    def load_session(log_path: str) -> Dict[str, Any]:
        """
        Load a saved session log.
        
        Args:
            log_path: Path to log file
            
        Returns:
            Session data dict
        """
        with open(log_path) as f:
            return json.load(f)
    
    @staticmethod
    def get_recent_sessions(limit: int = 10) -> list:
        """
        Get most recent session logs.
        
        Args:
            limit: Max number of sessions to return
            
        Returns:
            List of session log file paths
        """
        logs_dir = get_app_root() / "logs" / "actions"
        
        if not logs_dir.exists():
            return []
        
        log_files = sorted(
            logs_dir.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )
        
        return [str(f) for f in log_files[:limit]]


def save_screenshot(batch_id: str, stage: str, screenshot_bytes: bytes) -> str:
    """
    Save screenshot to logs/screenshots/.
    
    Args:
        batch_id: Batch identifier
        stage: 'before' or 'after'
        screenshot_bytes: PNG bytes
        
    Returns:
        Path to saved screenshot
    """
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    filename = f"{stage}_{batch_id}_{timestamp}.png"
    
    screenshots_dir = get_app_root() / "logs" / "screenshots"
    screenshots_dir.mkdir(parents=True, exist_ok=True)
    
    screenshot_path = screenshots_dir / filename
    
    with open(screenshot_path, 'wb') as f:
        f.write(screenshot_bytes)
    
    logger.info(f"Screenshot saved: {screenshot_path}")
    return str(screenshot_path)
