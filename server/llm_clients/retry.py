"""
Transient-failure retry layer for LLM clients.
===============================================
Issue #85: a single transient 429/5xx from the LLM endpoint used to
immediately degrade the planner into the heuristic fallback, which then
typed "Test Data" into the first live input - clobbering the agent's own
search query. This module adds in-client retry with exponential backoff
(respecting Retry-After) so a transient blip no longer destroys the run.

Both CustomEndpointClient and OllamaClient use `with_retry` around their
HTTP call. The helper is also importable for tests.
"""

import asyncio
import os
from typing import Callable, Type, Union

import httpx

# Transient HTTP status codes worth retrying: 429 (rate limit) and 5xx
# (server-side trouble). 4xx that are not 429 are permanent client errors
# (bad key, bad model name) - retrying them just wastes time.
RETRYABLE_STATUS = frozenset({429}) | set(range(500, 600))


class LLMRateLimitError(Exception):
    """
    All retries exhausted while the endpoint kept returning a transient
    status (429/5xx). Carries the last HTTP response so callers can decide
    (the planner degrades with a clear reason instead of blindly acting).
    """

    def __init__(self, message: str, last_status: int, retries: int):
        super().__init__(message)
        self.last_status = last_status
        self.retries = retries


def _retry_after_seconds(response: httpx.Response) -> Union[int, None]:
    """Honour a Retry-After header if the server sent one."""
    raw = response.headers.get("retry-after")
    if not raw:
        return None
    try:
        return max(0, int(float(raw)))
    except (ValueError, TypeError):
        return None


def _backoff_delay(attempt: int, retry_after: Union[int, None] = None) -> float:
    """
    Exponential backoff: 1s, 2s, 4s ... capped at 30s, plus a small jitter
    so a burst of concurrent /plan calls doesn't hammer the same endpoint
    on the same second. A server-provided Retry-After wins over the cap
    (a provider telling us to wait 5 minutes means it will 429 us again
    sooner if we ignore it - but we still bound it at 60s so the loop and
    the 30s client timeout stay sane).
    """
    import random
    base = min(30.0, 1.0 * (2 ** attempt))  # 1s, 2s, 4s, 8s, 16s, 32->30s...
    delay = base + random.uniform(0, 0.5)
    if retry_after is not None:
        delay = max(delay, min(retry_after, 60.0))
    return delay


async def with_retry(
    post: Callable[[httpx.AsyncClient], "object"],
    *,
    attempts: int = 4,
    name: str = "LLM",
    timeout: float = 30.0,
) -> httpx.Response:
    """
    Run an async `post(client)` (which returns an httpx.Response) with
    exponential-backoff retry on transient failures.

    - Retries on: httpx transport errors (connection/timeout) and HTTP
      status in RETRYABLE_STATUS (429 + 5xx).
    - Does NOT retry on permanent 4xx (401/400/404) - raises immediately.
    - `attempts` is the total number of tries (1 initial + 3 retries).
    - `timeout` is the per-request client timeout (Ollama uses 60s,
      custom endpoints 30s - matches the pre-retry behaviour).
    - If every try is exhausted while transient, raises
      LLMRateLimitError carrying the last status code.

    The caller owns the response lifecycle: after with_retry returns, the
    caller may call raise_for_status() for the permanent-error path or
    read .json() for the success path.
    """
    delay_override = os.getenv("SIH_LLM_RETRY_BASE_DELAY")
    last_response: httpx.Response | None = None

    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(attempts):
            try:
                response = await post(client)
            except httpx.TransportError as e:
                # Connection refused / DNS / timeout - the provider is
                # temporarily unreachable. Last error kind is transport.
                last_response = None
                if attempt == attempts - 1:
                    raise LLMRateLimitError(
                        f"{name}: transport error after {attempts} attempts ({e.__class__.__name__})",
                        last_status=0, retries=attempt + 1,
                    ) from e
                delay = _backoff_delay(attempt)
                if delay_override:
                    delay = float(delay_override)
                if os.getenv("SIH_LLM_RETRY_VERBOSE", "1") != "0":
                    print(f"[llm-retry] {name} transport error ({e.__class__.__name__}), "
                          f"backoff {delay:.1f}s (attempt {attempt + 1}/{attempts})")
                await asyncio.sleep(delay)
                continue

            last_response = response
            if response.status_code in RETRYABLE_STATUS:
                retry_after = _retry_after_seconds(response)
                if attempt == attempts - 1:
                    raise LLMRateLimitError(
                        f"{name}: still rate-limited (HTTP {response.status_code}) "
                        f"after {attempts} attempts",
                        last_status=response.status_code, retries=attempt + 1,
                    )
                delay = _backoff_delay(attempt, retry_after)
                if delay_override:
                    delay = float(delay_override)
                if os.getenv("SIH_LLM_RETRY_VERBOSE", "1") != "0":
                    print(f"[llm-retry] {name} HTTP {response.status_code}, "
                          f"backoff {delay:.1f}s (attempt {attempt + 1}/{attempts})")
                await asyncio.sleep(delay)
                continue

            # Non-retryable status (4xx except 429) or success: stop here.
            # Success returns to the caller; permanent errors are surfaced
            # by the caller's raise_for_status().
            return response

    # Unreachable: the loop above always either returns or raises.
    raise LLMRateLimitError(
        f"{name}: retry loop exhausted", last_status=-1, retries=attempts
    )


__all__ = [
    "with_retry",
    "LLMRateLimitError",
    "RETRYABLE_STATUS",
]
