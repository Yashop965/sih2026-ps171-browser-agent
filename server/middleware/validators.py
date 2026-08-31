"""
Request Validation and Rate Limiting Middleware

Implements:
1. 50KB maximum request body payload protection (HTTP 413)
2. In-memory sliding window rate limiting (HTTP 429)
"""

import time
from typing import Dict, List
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

MAX_PAYLOAD_BYTES = 50 * 1024  # 50 KB
RATE_LIMIT_REQUESTS = 60       # Max 60 requests per minute
RATE_LIMIT_WINDOW_SECONDS = 60


class PayloadSizeLimitMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, max_bytes: int = MAX_PAYLOAD_BYTES):
        super().__init__(app)
        self.max_bytes = max_bytes

    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method in ["POST", "PUT", "PATCH"]:
            content_length = request.headers.get("content-length")
            if content_length and content_length.isdigit():
                if int(content_length) > self.max_bytes:
                    return JSONResponse(
                        {
                            "success": False,
                            "error": f"Payload size exceeds maximum allowed limit of {self.max_bytes} bytes (50KB)",
                            "message": "Request entity too large",
                        },
                        status_code=413,
                    )
            
            # Inspect body chunk sizes for requests without or with chunked Content-Length
            body = await request.body()
            if len(body) > self.max_bytes:
                return JSONResponse(
                    {
                        "success": False,
                        "error": f"Payload size exceeds maximum allowed limit of {self.max_bytes} bytes (50KB)",
                        "message": "Request entity too large",
                    },
                    status_code=413,
                )

        return await call_next(request)


class RateLimiterMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        max_requests: int = RATE_LIMIT_REQUESTS,
        window_seconds: int = RATE_LIMIT_WINDOW_SECONDS,
    ):
        super().__init__(app)
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self.client_records: Dict[str, List[float]] = {}

    async def dispatch(self, request: Request, call_next) -> Response:
        # Exempt health endpoint from strict rate limiting
        if request.url.path == "/health":
            return await call_next(request)

        client_ip = request.client.host if request.client else "127.0.0.1"
        now = time.time()
        cutoff = now - self.window_seconds

        # Clean old records for this client
        timestamps = self.client_records.get(client_ip, [])
        timestamps = [t for t in timestamps if t > cutoff]

        if len(timestamps) >= self.max_requests:
            return JSONResponse(
                {
                    "success": False,
                    "error": f"Rate limit exceeded. Maximum {self.max_requests} requests per minute.",
                    "message": "Too many requests",
                },
                status_code=429,
            )

        timestamps.append(now)
        self.client_records[client_ip] = timestamps

        return await call_next(request)
