#!/usr/bin/env python3
"""Compare agnes-2.5-flash (reasoning) vs agnes-3.0-flash (fast) on the FULL
planner prompt: latency + is the JSON action parseable + sensible.
"""
import os
import json
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from server.planner import ActionPlanner, MockLLMClient  # noqa: E402

ENV = dict(re.findall(r"^([A-Z0-9_]+)=(.*)$", open("server/.env").read(), re.M))
KEY = ENV["LLM_API_KEY"]
BASE = ENV.get("LLM_API_URL", "").rstrip("/")

planner = ActionPlanner(llm_client=MockLLMClient())
elements = [
    {"id": 0, "stableId": "input|search", "tag": "input", "type": "search", "role": "textbox", "label": "search wikipedia", "interactive": True, "isPassword": False},
    {"id": 1, "stableId": "button|go", "tag": "button", "type": "button", "role": "button", "label": "go", "interactive": True, "isPassword": False},
    {"id": 2, "stableId": "a|wwweb", "tag": "a", "type": "", "role": "link", "label": "world wide web", "interactive": True, "isPassword": False},
] + [
    {"id": i, "stableId": f"link{i}", "tag": "a", "type": "", "role": "link", "label": f"nav link {i}", "interactive": True, "isPassword": False}
    for i in range(3, 30)
]
prompt = planner.build_context_prompt(
    url="https://en.wikipedia.org/wiki/Main_Page",
    title="Wikipedia, the free encyclopedia",
    interactive_elements=elements,
    accessibility_tree=[],
    task_description="Using the Wikipedia search box, look up 'World Wide Web' and open that article. Then look up 'Tim Berners-Lee' and open it. Then look up 'Hypertext' and open it. COMPLETE only when the Hypertext article is on screen.",
    history=[
        {"action": "CLICK", "targetId": 0, "result": "OK"},
        {"action": "TYPE", "targetId": 0, "result": "OK"},
    ],
    context={"scrollY": 0, "scrollHeight": 3190, "viewport": {"w": 1280, "h": 800}, "moreContentBelow": True, "omitted": 423},
    checklist=[
        {"id": "1", "description": "search World Wide Web", "done": True},
        {"id": "2", "description": "open World Wide Web article", "done": False},
    ],
    loop_warning=None,
)
SYS = "You are a browser automation assistant. Given sanitized webpage metadata, determine the single next action to execute in JSON format."
print(f"prompt size: {len(prompt)} chars (~{len(prompt)//4} tokens)")

for model in ["agnes-2.5-flash", "agnes-3.0-flash"]:
    body = {
        "model": model,
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": prompt}],
        "max_tokens": 2000,
        "temperature": 0,
    }
    req = urllib.request.Request(
        BASE + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.loads(r.read().decode())
        dt = time.time() - t0
        msg = (data.get("choices") or [{}])[0].get("message", {})
        c = msg.get("content") or msg.get("reasoning_content") or ""
        m = re.search(r"\{.*\}", c, re.S)
        act = None
        parseable = False
        if m:
            try:
                act = json.loads(m.group(0))
                parseable = True
            except Exception:
                pass
        print(f"\n{model}: {dt:.1f}s  parseable={parseable}  action={act}")
        if not parseable:
            print(f"  raw head: {c.replace(chr(10),' ')[:150]}")
    except Exception as e:
        print(f"\n{model}: {type(e).__name__}: {e}")
