#!/usr/bin/env python3
"""Time a realistic planning call across candidate agnes models.
Picks the fastest one that still returns parseable planning JSON.
"""
import json
import re
import time
import urllib.error
import urllib.request

ENV = open("server/.env").read()
KEY = re.search(r"LLM_API_KEY=(\S+)", ENV).group(1)
URL = "https://apihub.agnes-ai.com/v1/chat/completions"

# A realistic-ish but small planning task.
SYS = "You are a browser automation assistant. Given sanitized webpage metadata, determine the single next action to execute in JSON format."
USR = """URL: https://en.wikipedia.org/wiki/Main_Page
PAGE TITLE: Wikipedia, the free encyclopedia
TASK: Using the search box, look up "World Wide Web" and open that article.

INTERACTIVE ELEMENTS:
[2] <input text role=textbox> "Search Wikipedia"

Reply with ONLY JSON: {"action":"TYPE","targetId":2,"value":"World Wide Web"}"""

CANDIDATES = [
    "agnes-3.0-flash",
    "agnes-2.5-flash",
    "agnes-3.0-pro",
]


def probe(model):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": USR}],
        "max_tokens": 500,
        "temperature": 0,
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"{model:16s}: HTTP {e.code} {e.read().decode()[:200]}")
        return
    except Exception as e:
        print(f"{model:16s}: {type(e).__name__} {e}")
        return
    dt = time.time() - t0
    msg = (data.get("choices") or [{}])[0].get("message", {})
    c = msg.get("content") or ""
    rc = msg.get("reasoning_content") or ""
    ok_json = c.strip().startswith("{") and "action" in c
    print(f"{model:16s}: {dt:6.1f}s  content={len(c):3d}  reasoning={len(rc):4d}  parseable={ok_json}  finish={(data.get('choices') or [{}])[0].get('finish_reason')}")


for m in CANDIDATES:
    probe(m)
