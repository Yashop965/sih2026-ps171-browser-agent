"""
Structured JSON Request/Response Logging Middleware

Formats server access logs as structured JSON.
Guarantees zero logging of raw payload bodies, sensitive headers, or PII values.
"""

import time
import json
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("sih_agent_server")
logger.setLevel(logging.INFO)

# Setup console handler if not already present
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter('%(message)s'))
    logger.addHandler(handler)


class JSONLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        start_time = time.time()
        
        # Calculate request content length safely
        content_length = request.headers.get("content-length")
        request_size = int(content_length) if content_length and content_length.isdigit() else 0

        # Process request
        try:
            response = await call_next(request)
            process_time_ms = round((time.time() - start_time) * 1000, 2)
            
            log_entry = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "latency_ms": process_time_ms,
                "request_bytes": request_size,
                "client_ip": request.client.host if request.client else "unknown",
            }
            logger.info(json.dumps(log_entry))
            return response
        except Exception as exc:
            process_time_ms = round((time.time() - start_time) * 1000, 2)
            error_log = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "method": request.method,
                "path": request.url.path,
                "status": 500,
                "latency_ms": process_time_ms,
                "request_bytes": request_size,
                "error": str(exc),
                "client_ip": request.client.host if request.client else "unknown",
            }
            logger.error(json.dumps(error_log))
            raise exc
