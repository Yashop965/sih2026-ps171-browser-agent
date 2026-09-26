"""
Tests for the #172 exposure fix: authentication, origin policy, bind safety.

The point of these is to prove the server now REJECTS what it used to accept.
A test that only checks the happy path would pass against the old,
completely open server too.
"""

import importlib
import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Each test states its own env; no leakage between them."""
    monkeypatch.delenv("SERVER_API_TOKEN", raising=False)
    monkeypatch.delenv("SERVER_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("SERVER_HOST", raising=False)
    yield


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    """
    `rate_limit_store` is a module-level dict in server/middleware/validators.py
    (not a class attribute) with no reset hook, and RateLimitingMiddleware keys it
    on client IP - which is 127.0.0.1 for every TestClient in the suite. The cap
    is 100 requests per 60s, so these tests both exhausted it themselves and
    poisoned test_main.py when the whole directory ran (429 instead of 401).

    Cleared before and after each test so this file is order-independent.
    """
    from server.middleware import validators

    validators.rate_limit_store.clear()
    yield
    validators.rate_limit_store.clear()


def _load_security():
    import server.security as sec

    return importlib.reload(sec)


def _load_main():
    import server.main as m

    return importlib.reload(m)


# ── token enforcement ────────────────────────────────────────────────────────

def test_missing_token_is_rejected_when_a_token_is_configured(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    r = client.post("/plan", json={})
    assert r.status_code == 401, f"expected 401 without a token, got {r.status_code}"


def test_wrong_token_is_rejected(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    r = client.post("/plan", json={}, headers={"X-Agent-Token": "wrong"})
    assert r.status_code == 401


def test_correct_token_is_accepted(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    r = client.post("/plan", json={}, headers={"X-Agent-Token": "s3cret"})
    assert r.status_code != 401, "a valid token must not be rejected"


def test_token_guards_every_state_changing_route(monkeypatch):
    """The old server exposed all of these with no auth at all."""
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    assert client.post("/execute", json={}).status_code == 401
    assert client.post("/verify-pii", json={}).status_code == 401
    assert client.get("/sessions/abc").status_code == 401


def test_health_stays_open_so_the_popup_can_show_status(monkeypatch):
    """Popup.tsx polls /health unauthenticated; gating it would show 'unhealthy'."""
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    assert client.get("/health").status_code == 200


def test_no_token_configured_means_no_auth_prompt(monkeypatch):
    """Fresh-clone convenience: unset token, no 401."""
    monkeypatch.delenv("SERVER_API_TOKEN", raising=False)
    main = _load_main()
    client = TestClient(main.app)

    r = client.post("/plan", json={})
    assert r.status_code != 401


# ── origin policy ────────────────────────────────────────────────────────────

def test_disallowed_origin_is_refused(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    r = client.post(
        "/plan",
        json={},
        headers={"X-Agent-Token": "s3cret", "Origin": "https://evil.example"},
    )
    assert r.status_code == 403, f"expected 403 for a hostile origin, got {r.status_code}"


def test_allowlisted_origin_is_accepted(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    main = _load_main()
    client = TestClient(main.app)

    r = client.post(
        "/plan",
        json={},
        headers={"X-Agent-Token": "s3cret", "Origin": "chrome-extension://localhost"},
    )
    assert r.status_code != 403


def test_origin_allowlist_is_configurable(monkeypatch):
    monkeypatch.setenv("SERVER_ALLOWED_ORIGINS", "https://app.example, https://x.test")
    sec = _load_security()

    assert sec.origin_is_allowed("https://app.example")
    assert sec.origin_is_allowed("https://x.test")
    assert not sec.origin_is_allowed("https://evil.example")


def test_absent_origin_is_allowed(monkeypatch):
    """Extension SW, curl and tests send no Origin. A browser always does."""
    sec = _load_security()
    assert sec.origin_is_allowed(None)
    assert sec.origin_is_allowed("")


def test_wildcard_origin_is_not_in_the_default_policy():
    """The old config was ['*'] with credentials - the actual bug."""
    sec = _load_security()
    assert "*" not in sec.configured_origins()


# ── bind safety ──────────────────────────────────────────────────────────────

def test_wildcard_bind_without_a_token_is_refused(monkeypatch):
    """The core fail-closed rule: no token => no off-host exposure."""
    monkeypatch.delenv("SERVER_API_TOKEN", raising=False)
    sec = _load_security()

    with pytest.raises(RuntimeError, match="SERVER_API_TOKEN"):
        sec.assert_safe_bind("0.0.0.0")


def test_wildcard_bind_with_a_token_is_allowed(monkeypatch):
    monkeypatch.setenv("SERVER_API_TOKEN", "s3cret")
    sec = _load_security()
    sec.assert_safe_bind("0.0.0.0")  # must not raise


def test_loopback_bind_is_always_allowed(monkeypatch):
    monkeypatch.delenv("SERVER_API_TOKEN", raising=False)
    sec = _load_security()
    sec.assert_safe_bind("127.0.0.1")
    sec.assert_safe_bind("localhost")


def test_loopback_only_reflects_token_absence(monkeypatch):
    sec = _load_security()
    monkeypatch.delenv("SERVER_API_TOKEN", raising=False)
    assert sec.is_loopback_only()
    monkeypatch.setenv("SERVER_API_TOKEN", "x")
    assert not sec.is_loopback_only()


# ── constant-time comparison ─────────────────────────────────────────────────

def test_token_comparison_is_constant_time(monkeypatch):
    """A short-circuiting == would leak the secret byte by byte to a local timer."""
    import inspect

    sec = _load_security()
    src = inspect.getsource(sec.require_api_token)
    assert "compare_digest" in src, "token check must use hmac.compare_digest"
