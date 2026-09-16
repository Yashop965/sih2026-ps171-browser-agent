"""
Issue #85 - in-client retry/backoff for the LLM endpoint.

A single transient 429 / 5xx used to instantly degrade the planner into the
destructive heuristic fallback (which typed "Test Data" into the first live
input). Now the client retries transient failures with exponential backoff,
honouring Retry-After, and only raises LLMRateLimitError when every attempt
is exhausted - at which point the planner degrades to the *conservative*
fallback that only touches task-referenced fields.

These tests exercise the retry layer directly with a fake `post` so no real
network is touched and no real backoff time is slept (SIH_LLM_RETRY_BASE_DELAY
is set to 0).
"""

import asyncio
import os
import unittest
from typing import Optional

import httpx

from server.llm_clients.retry import with_retry, LLMRateLimitError, RETRYABLE_STATUS


def _resp(status: int, retry_after: Optional[str] = None) -> httpx.Response:
    headers = {}
    if retry_after is not None:
        headers["retry-after"] = retry_after
    return httpx.Response(status, headers=headers, request=httpx.Request("POST", "http://x"))


class TestWithRetry85(unittest.TestCase):
    def setUp(self):
        # Zero out backoff so the tests run fast; restore afterwards.
        os.environ["SIH_LLM_RETRY_VERBOSE"] = "0"
        os.environ["SIH_LLM_RETRY_BASE_DELAY"] = "0"

    def tearDown(self):
        os.environ.pop("SIH_LLM_RETRY_VERBOSE", None)
        os.environ.pop("SIH_LLM_RETRY_BASE_DELAY", None)

    def test_success_on_first_try_makes_no_retries(self):
        calls = []

        async def post(client):
            calls.append(1)
            return _resp(200)

        r = asyncio.run(with_retry(post, attempts=4, name="t"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(calls), 1)

    def test_retries_429_then_succeeds(self):
        calls = []

        async def post(client):
            calls.append(1)
            if len(calls) < 3:
                return _resp(429, retry_after="0")
            return _resp(200)

        r = asyncio.run(with_retry(post, attempts=4, name="t"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(len(calls), 3, "should have taken 3 tries")

    def test_5xx_is_retried(self):
        calls = []

        async def post(client):
            calls.append(1)
            return _resp(503) if len(calls) < 4 else _resp(503)

        with self.assertRaises(LLMRateLimitError) as ctx:
            asyncio.run(with_retry(post, attempts=4, name="t"))
        self.assertEqual(ctx.exception.last_status, 503)
        self.assertEqual(len(calls), 4, "all 4 attempts used")
        self.assertEqual(ctx.exception.retries, 4)

    def test_transient_429_raises_LLMRateLimitError_with_status(self):
        async def post(client):
            return _resp(429)

        with self.assertRaises(LLMRateLimitError) as ctx:
            asyncio.run(with_retry(post, attempts=4, name="t"))
        self.assertEqual(ctx.exception.last_status, 429)

    def test_permanent_4xx_does_not_retry(self):
        calls = []

        async def post(client):
            calls.append(1)
            return _resp(401)

        # A 401 (bad key) must NOT be retried - the caller gets the response
        # back so raise_for_status() can surface it.
        r = asyncio.run(with_retry(post, attempts=4, name="t"))
        self.assertEqual(r.status_code, 401)
        self.assertEqual(len(calls), 1, "401 is permanent - no retries")

    def test_429_and_5xx_are_the_only_retryable_statuses(self):
        self.assertIn(429, RETRYABLE_STATUS)
        self.assertIn(500, RETRYABLE_STATUS)
        self.assertIn(503, RETRYABLE_STATUS)
        self.assertNotIn(400, RETRYABLE_STATUS)
        self.assertNotIn(401, RETRYABLE_STATUS)
        self.assertNotIn(404, RETRYABLE_STATUS)

    def test_transport_error_is_retried_then_raises(self):
        calls = []

        async def post(client):
            calls.append(1)
            raise httpx.ConnectError("connection refused")

        with self.assertRaises(LLMRateLimitError) as ctx:
            asyncio.run(with_retry(post, attempts=3, name="t"))
        self.assertEqual(ctx.exception.last_status, 0)  # no HTTP status (transport)
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
