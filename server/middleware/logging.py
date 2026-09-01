import json
import logging
import time
import uuid
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import Message

# Create logs directory if it doesn't exist in the project root
LOG_DIR = Path(__file__).resolve().parent.parent.parent / "logs"
try:
    LOG_DIR.mkdir(exist_ok=True)
except PermissionError:
    # Fallback to local or temp if permission denied
    import tempfile
    LOG_DIR = Path(tempfile.gettempdir()) / "sih2026_logs"
    LOG_DIR.mkdir(exist_ok=True)
LOG_FILE = LOG_DIR / "agent.log"

class JSONFormatter(logging.Formatter):
    """Formatter to output structured JSON logs."""
    def format(self, record: logging.LogRecord) -> str:
        log_obj = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "event": getattr(record, "event", "message"),
            "request_id": getattr(record, "request_id", None),
        }

        # Add message if present
        if record.getMessage() and record.getMessage() != "None":
            log_obj["message"] = record.getMessage()

        # Add extra fields (metrics, metadata)
        if hasattr(record, "metadata"):
            log_obj["metadata"] = record.metadata
            
        # Specific fields that might be passed in extra
        for field in ["endpoint", "method", "duration", "status_code", "error"]:
            if hasattr(record, field):
                log_obj[field] = getattr(record, field)

        return json.dumps(log_obj)

def setup_logging():
    """Configure rotating file logging with JSON format."""
    logger = logging.getLogger("agent")
    logger.setLevel(logging.INFO)
    
    # Avoid duplicate handlers if setup multiple times
    if logger.hasHandlers():
        logger.handlers.clear()

    # 7 days retention, rotate at midnight
    handler = TimedRotatingFileHandler(
        LOG_FILE, when="midnight", interval=1, backupCount=7, encoding="utf-8"
    )
    handler.setFormatter(JSONFormatter())
    logger.addHandler(handler)
    
    return logger

logger = setup_logging()

class StructuredLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        request_id = str(uuid.uuid4())
        # Attach request_id to request state so downstream endpoints/middlewares can use it
        request.state.request_id = request_id
        
        start_time = time.monotonic()
        
        # Log request received
        logger.info(
            "Request started",
            extra={
                "event": "request_received",
                "request_id": request_id,
                "endpoint": request.url.path,
                "method": request.method
            }
        )
        
        try:
            response = await call_next(request)
            duration = time.monotonic() - start_time
            
            logger.info(
                "Request completed",
                extra={
                    "event": "request_completed",
                    "request_id": request_id,
                    "endpoint": request.url.path,
                    "method": request.method,
                    "duration": round(duration, 4),
                    "status_code": response.status_code
                }
            )
            return response
            
        except Exception as e:
            duration = time.monotonic() - start_time
            # Log failure but never expose traceback in the structured payload
            logger.error(
                "Request failed",
                extra={
                    "event": "request_failed",
                    "request_id": request_id,
                    "endpoint": request.url.path,
                    "method": request.method,
                    "duration": round(duration, 4),
                    "error": type(e).__name__
                }
            )
            raise e
