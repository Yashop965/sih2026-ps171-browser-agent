#!/usr/bin/env python3
"""Probe whether agnes-2.5-flash accepts a thinking-off flag.
Runs the /v1/chat/completions call with and without candidate flags, times
each, and prints content + reasoning_content lengths so we can see whether
CoT was actually skipped (big latency win if yes).
"""
import json
import os
import re
import time
import urllib.request
import urllib.error

ENV = open("server/.env").read()
KEY = re.search(r"LLM_API_KEY=(\S+)", ENV).group(1)
MODEL = re.search(r"LLM_MODEL=(\S+)", ENV)
MODEL = MODEL.group(1) if MODEL else "agnes-2.5-flash"
URL = "https://apihub.agnes-ai.com/v1/chat/completions"

def probe(label, extra):
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": 2000,
        "temperature": 0,
        **extra,
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"{label}: HTTP {e.code}: {e.read().decode()[:300]}")
        return
    except Exception as e:
        print(f"{label}: {type(e).__name__}: {e}")
        return
    dt = time.time() - t0
    msg = (data.get("choices") or [{}])[0].get("message", {})
    usage = data.get("usage", {})
    c = (msg.get("content") or "")
    rc = (msg.get("reasoning_content") or "")
    print(f"{label}: {dt:.1f}s code={data.get('code')} content={len(c)!r} reasoning={len(rc)!r} usage={usage.get('completion_tokens_details')} finish={data.get('choices',[{}])[0].get('finish_reason')}")

probe("baseline           ", {})
probe("enable_thinking=F  ", {"enable_thinking": False})
probe("thinking=disabled  ", {"thinking": {"type": "disabled"}})
probe("thinking_budget=0  ", {"thinking_budget": 0})
