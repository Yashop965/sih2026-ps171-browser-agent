"""
#192 (re-review) — the planner now CHECKS the NAVIGATE url, it does not just ask.

The prompt says "MUST be absolute". That is a request to the model, not a
check. Before this, a relative url passed the planner's only NAVIGATE
validation (`not url` — is a url present at all), reached the service worker,
and failed there — where a navigate failure sets the run status to 'failed'
and ends the task.

So a relative url did not waste a step. It terminated the run.

The URL-classification test EXTRACTS the predicate from the shipped planner
source and runs it, rather than asserting on source text or on a hand-copied
duplicate. The first version of this file did the latter and passed 16/16
against a deliberately broken planner (`has_authority = True`) — the kind of
test that looks like coverage and is not.
"""

import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

PLANNER = ROOT / "server" / "planner.py"


def _planner_source() -> str:
    return PLANNER.read_text(encoding="utf-8")


def _planner_predicate():
    """
    Pull the real `has_authority = ...` expression out of planner.py and
    compile it, so the test runs the shipped logic instead of a copy.
    """
    src = _planner_source()
    m = re.search(r"has_authority\s*=\s*(.+)", src)
    assert m, "planner.py no longer computes has_authority"
    expr = m.group(1).strip()
    ns: dict = {}
    exec(  # noqa: S102 - one extracted expression from our own repo
        compile(
            "def _pred(candidate):\n"
            "    candidate = candidate.strip()\n"
            f"    return {expr}\n",
            "<planner>",
            "exec",
        ),
        ns,
    )
    return ns["_pred"]


def test_source_has_the_relative_url_guard():
    src = _planner_source()
    assert 'raw_type == "NAVIGATE" and url:' in src
    assert "has_authority" in src
    assert "NAVIGATE url must be absolute" in src


@pytest.mark.parametrize(
    "candidate,expected",
    [
        # Absolute - must pass through untouched.
        ("https://bank.example/profile", True),
        ("http://bank.example/profile", True),
        # Protocol-relative - carries its own authority, so it is fine.
        ("//bank.example/profile", True),
        # Relative - must be caught.
        ("/profile", False),
        ("profile", False),
        ("./profile", False),
        ("../profile", False),
        ("?tab=2", False),
        ("#section", False),
        ("bank.example/profile", False),
        # Whitespace around an absolute url is still absolute.
        ("  https://bank.example/x  ", True),
    ],
)
def test_the_shipped_predicate_classifies_urls(candidate, expected):
    """Runs the predicate as extracted from planner.py, not a copy of it."""
    assert _planner_predicate()(candidate) is expected


def test_the_guard_degrades_to_a_fallback_not_a_crash():
    """
    A relative url must reach `_fallback_action`, the same path a missing url
    already uses, rather than raising or returning the action unchanged.
    """
    src = _planner_source()
    i = src.index("NAVIGATE url must be absolute")
    around = src[max(0, i - 700) : i + 200]
    assert "_fallback_action" in around


def test_missing_url_guard_still_present():
    """The original presence check must not have been replaced, only added to."""
    src = _planner_source()
    assert 'if raw_type == "NAVIGATE" and not url:' in src
    assert "NAVIGATE action missing url" in src


def test_prompt_still_states_the_requirement():
    """
    The prompt line is kept even though the check now exists — the check
    prevents the failure, the prompt reduces how often it happens.
    """
    src = _planner_source()
    assert "MUST be absolute" in src
