import time
import re
from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

MAX_PAYLOAD_SIZE = 50 * 1024  # 50 KB

class PayloadSizeLimitMiddleware(BaseHTTPMiddleware):
    """Rejects requests with Content-Length exceeding 50 KB."""
    async def dispatch(self, request: Request, call_next):
        if request.method in ("POST", "PUT", "PATCH"):
            content_length = request.headers.get("content-length")
            if content_length:
                try:
                    if int(content_length) > MAX_PAYLOAD_SIZE:
                        return JSONResponse(
                            status_code=413,
                            content={
                                "success": False,
                                "error": "Payload Too Large",
                                "message": f"Request exceeds maximum allowed size of {MAX_PAYLOAD_SIZE} bytes."
                            }
                        )
                except ValueError:
                    return JSONResponse(
                        status_code=400,
                        content={"success": False, "error": "Bad Request", "message": "Invalid Content-Length header"}
                    )
            # Note: For chunked transfers without Content-Length, this won't catch it here,
            # but standard browser fetch sends Content-Length.
        
        return await call_next(request)


# Rate limit configuration
RATE_LIMIT = 100
RATE_WINDOW = 60  # seconds

# In-memory store: { "ip_address": {"count": int, "reset_at": float} }
rate_limit_store = {}

class RateLimitingMiddleware(BaseHTTPMiddleware):
    """Limits requests to 100 per minute per IP."""
    async def dispatch(self, request: Request, call_next):
        client_ip = request.client.host if request.client else "127.0.0.1"
        now = time.time()
        
        # Initialize or reset window
        record = rate_limit_store.get(client_ip)
        if not record or now > record["reset_at"]:
            rate_limit_store[client_ip] = {"count": 1, "reset_at": now + RATE_WINDOW}
        else:
            if record["count"] >= RATE_LIMIT:
                return JSONResponse(
                    status_code=429,
                    content={
                        "success": False,
                        "error": "Too Many Requests",
                        "message": "Rate limit exceeded. Try again later."
                    }
                )
            record["count"] += 1
            
        return await call_next(request)


def sanitize_text(text: str) -> str:
    """
    Strips dangerous control characters while preserving semantic text.
    Removes ASCII control characters (0-31) except newline/tab.
    """
    if not text:
        return text
    # Remove all control characters except \n, \r, \t
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
