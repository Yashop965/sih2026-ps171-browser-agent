"""#205 part 2 — a planner-chosen id must survive the round trip.

Source-text assertions are not enough here, and this file exists because they
were not enough. Two separate checks had to be widened before a stableId
actually reached the executor:

  1. `ActionSchema.targetId` was `Optional[int]`, so pydantic coerced the id
     back to a positional integer before the response was built.
  2. `valid_element_ids` held positional ids only, so a correctly-resolved
     stableId was then rejected and the planner fell back to a conservative
     action with the message "Target element #... not found on page".

Both passed every source-level test while the feature remained a complete
no-op. So these call `parse_llm_output` - the method that contains both - and
assert the id that actually comes out.
"""

import json
import logging
import sys
from pathlib import Path

import pytest

# Resolve the repo root from THIS file, not a hardcoded absolute path. CI runs
# on Linux, where a Windows path silently "works" locally and then fails there -
# the first version of this file had exactly that bug and 2 tests failed in CI
# while passing on the author's machine.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.planner import ActionPlanner  # noqa: E402

ELEMENTS = [
    {
        "id": 1,
        "stableId": "button|||print_summary",
        "tag": "button",
        "type": None,
        "role": "button",
        "label": "print summary",
        "interactive": True,
        "filled": False,
    },
    {
        "id": 2,
        "stableId": "input|email|textbox|email",
        "tag": "input",
        "type": "email",
        "role": "textbox",
        "label": "email",
        "interactive": True,
        "filled": False,
    },
]

KNOWN_STABLE = "input|email|textbox|email"


@pytest.fixture(autouse=True)
def _quiet():
    logging.disable(logging.CRITICAL)
    yield
    logging.disable(logging.NOTSET)


@pytest.fixture
def planner() -> ActionPlanner:
    return ActionPlanner.__new__(ActionPlanner)


def parse(planner: ActionPlanner, target):
    llm = json.dumps({"type": "CLICK", "targetId": target})
    return planner.parse_llm_output(llm, ELEMENTS)


def test_a_known_stable_id_reaches_the_action_as_a_string(planner):
    """The whole point: the id must arrive as a str, not be coerced to an int."""
    out = parse(planner, KNOWN_STABLE)
    assert out.action.targetId == KNOWN_STABLE
    assert isinstance(out.action.targetId, str)


def test_a_stable_id_is_not_reported_as_a_missing_element(planner):
    """The regression that hid this: the id resolved, then a second check
    rejected it and the planner returned the "not found on page" fallback."""
    out = parse(planner, KNOWN_STABLE)
    assert "not found on page" not in (out.reasoning or "")
    assert "Conservative fallback" not in (out.reasoning or "")


def test_a_numeric_id_still_works_as_an_int(planner):
    """No regression for a planner that emits the positional id, which is the
    shape the model has always produced."""
    out = parse(planner, 1)
    assert out.action.targetId == 1
    assert isinstance(out.action.targetId, int)


def test_a_numeric_string_still_resolves_to_an_int(planner):
    out = parse(planner, "1")
    assert out.action.targetId == 1


def test_an_unknown_stable_id_is_dropped_not_forwarded(planner):
    """Fail closed: an id the executor has no entry for must not be passed on
    as if it were resolvable."""
    out = parse(planner, "not_a_real_id_xyz")
    assert out.action.targetId is None


def test_an_id_for_an_absent_element_is_dropped(planner):
    """Same, for a well-formed id that is simply not on this page - e.g. a
    stableId from the previous page after a navigation."""
    out = parse(planner, "input|gone|textbox|nothing")
    assert out.action.targetId is None


def test_the_element_table_still_advertises_the_numeric_id(planner):
    """The numeric id must keep being sent: the executor, the outbound gate and
    every runner consumer still handle it, and removing it would be a much larger
    change than this issue."""
    src = (ROOT / "server" / "planner.py").read_text(encoding="utf-8")
    assert '"targetId": element_id' in src
    assert '"stableId": element_stable_id' in src


def test_the_outbound_gate_can_still_classify_a_send_on_a_stable_id():
    """A stableId target must not make the gate blind. If findElement only
    matched `id`, a send-classified action on a stableId target would find no
    element and could not be classified - failing OPEN on a send gate."""
    gate = (ROOT / "src" / "lib" / "outboundGate.ts").read_text(encoding="utf-8")
    i = gate.index("function findElement")
    body = gate[i : gate.index("\n  }", i)]
    assert "String(el.id) === key" in body
    assert "String(el.stableId) === key" in body


def test_this_file_uses_no_machine_specific_path():
    """This test file reads repo source, so it needs the repo root. Resolving it
    from a hardcoded absolute path passes on the author's machine and fails in
    CI on Linux - which is exactly what happened on the first attempt, with the
    failure only visible in CI. Assert the root is derived, not literal."""
    src = Path(__file__).resolve().read_text(encoding="utf-8")
    assert "Path(__file__).resolve().parent.parent" in src
    # and it must actually resolve to the files the tests read
    assert (ROOT / "server" / "planner.py").is_file()
    assert (ROOT / "src" / "lib" / "outboundGate.ts").is_file()
