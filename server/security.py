"""
Request authentication and origin policy for the planner server.

Issue #172: the server was started with host="0.0.0.0", CORS
allow_origins=["*"] together with allow_credentials=True, and no
authentication on any endpoint. Any web page the user visited could issue a
credentialed POST to http://localhost:8000/plan and drive the planner, or read
back /sessions/{id}.

Three independent controls, each of which alone is a meaningful barrier:

1. `require_api_token` - a shared secret, sent by the extension as
   `X-Agent-Token`. When SERVER_API_TOKEN is unset the check is skipped so a
   fresh clone still runs, but the server then refuses to bind to anything but
   loopback (see `is_loopback_only`). That pairing is deliberate: you cannot
   have both "no token configured" and "reachable from the network".
2. `origin_is_allowed` - an explicit allowlist for browser-originated requests.
   A wildcard origin is incompatible with credentials, and the previous
   configuration asserted both, which browsers reject anyway.
3. Loopback binding - the default host is 127.0.0.1, not 0.0.0.0, so the
   socket is not reachable from another machine even with a valid token.
"""

import os
import hmac
import re
from typing import Optional
from fastapi import HTTPException, Request

# Origins allowed to call the API from a browser context.
#
# Chrome and Firefox do NOT derive a stable extension id a server can guess:
# an unpacked extension's id is a hash of its install PATH, so it differs per
# machine and per directory. The previous hardcoded
# ["chrome-extension://localhost", ...] therefore 403'd the real extension in
# every ordinary unpacked install - verified live: the SW's own fetch to
# /plan returned `{"detail":"Origin not allowed"}` while the planner was
# healthy and curl succeeded.
#
# The scheme itself is the security boundary here, not the id. A hostile web
# page is always `https:`/`http:` and can never present a
# `chrome-extension://` or `moz-extension://` origin to a fetch it makes
# itself. So matching the scheme admits the extension regardless of where it is
# installed, and still rejects every web page - which is the entire threat this
# control exists for (issue #172).
#
# An operator who wants a tighter list can still set SERVER_ALLOWED_ORIGINS to
# exact origins; that replaces the defaults wholesale.
DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
    r"chrome-extension://[a-z]{32}",
    r"moz-extension://[a-z0-9-]+",
]

TOKEN_HEADER = "X-Agent-Token"


def configured_origins() -> list[str]:
    """Exact origins from SERVER_ALLOWED_ORIGINS, else the scheme defaults."""
    raw = os.getenv("SERVER_ALLOWED_ORIGINS", "")
    parsed = [o.strip() for o in raw.split(",") if o.strip()]
    return parsed or list(DEFAULT_ALLOWED_ORIGIN_PATTERNS)


def expected_token() -> Optional[str]:
    """
    The shared secret, or None when unconfigured.

    Read per-request rather than captured at import so a test (or an operator)
    can set the env var after startup.
    """
    token = os.getenv("SERVER_API_TOKEN", "").strip()
    return token or None


def is_loopback_only() -> bool:
    """
    True when no token is configured.

    In that state the server must only listen on loopback; `assert_safe_bind`
    enforces that. This is what makes "no token" fail closed instead of open.
    """
    return expected_token() is None


def assert_safe_bind(host: str) -> None:
    """
    Refuse a non-loopback bind without a token.

    Without this, SERVER_API_TOKEN unset plus host="0.0.0.0" would expose an
    unauthenticated planner to every interface on the machine.
    """
    if host in ("0.0.0.0", "::", ""):
        if is_loopback_only():
            raise RuntimeError(
                "Refusing to bind 0.0.0.0 with no SERVER_API_TOKEN. Either set "
                "SERVER_API_TOKEN, or bind to 127.0.0.1. An unauthenticated "
                "planner must never be reachable off-host (issue #172)."
            )


def require_api_token(request: Request) -> None:
    """
    Enforce the shared secret on state-changing endpoints.

    No-op when SERVER_API_TOKEN is unset (fresh-clone convenience); the bind
    host is what keeps that safe.
    """
    expected = expected_token()
    if expected is None:
        return
    provided = request.headers.get(TOKEN_HEADER, "")
    # Constant-time: a length/content comparison that short-circuits would
    # leak the secret byte by byte to a local attacker able to time requests.
    if not hmac.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Invalid or missing agent token")


def origin_is_allowed(origin: Optional[str]) -> bool:
    """Allow requests with no Origin (curl, tests); gate everything else.

    A browser always sends Origin on cross-origin fetches, so its absence means
    this is not a hostile web page. Anything present must match the allowlist.

    Each entry is treated as a regex, not a literal, so the defaults can match
    any extension id while an operator-supplied exact origin still works
    (a literal string is a valid regex that matches itself). `fullmatch` keeps
    a pattern from matching a longer hostile origin by prefix.
    """
    if not origin:
        return True
    return any(re.fullmatch(p, origin) for p in configured_origins())
