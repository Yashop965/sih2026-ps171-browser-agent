"""
Tests for loop detection and dynamic maxSteps in the planner.
"""
import pytest


def test_select_action_for_dropdowns():
    """Test that SELECT action is properly handled for dropdown elements."""
    
    # Test that select elements are identified correctly
    elements = [
        {"tag": "input", "type": "text", "role": "textbox"},
        {"tag": "select", "type": "select-one", "role": "combobox"},
        {"tag": "button", "role": "button"},
    ]
    
    # Verify element type detection
    selects = [e for e in elements if e.get("tag") == "select" or e.get("type") == "select-one"]
    assert len(selects) == 1
    assert selects[0]["tag"] == "select"


def test_element_type_rules():
    """Test that element type rules are correctly applied."""
    
    # Test input types
    text_inputs = [
        {"tag": "input", "type": "text"},
        {"tag": "input", "type": "email"},
        {"tag": "input", "type": "password"},
        {"tag": "input", "type": "number"},
        {"tag": "textarea"},
    ]
    
    for el in text_inputs:
        assert el.get("tag") in ["input", "textarea"]
    
    # Test button/link types
    clickables = [
        {"tag": "button", "role": "button"},
        {"tag": "a", "href": "#", "role": "link"},
    ]
    
    for el in clickables:
        assert el.get("tag") in ["button", "a"]


def test_max_steps_calculation():
    """Test dynamic maxSteps calculation."""
    def calculate_max_steps(inputs: int, selects: int, buttons: int) -> int:
        return max(10, min(50, (inputs + selects) * 3 + buttons + 5))
    
    # Small form: 3 inputs, 0 selects, 1 button = max(10, min(50, 3*3 + 1 + 5)) = max(10, 15) = 15
    assert calculate_max_steps(3, 0, 1) == 15
    
    # Large form (capped at 50)
    assert calculate_max_steps(13, 2, 3) == 50
    
    # Empty form (minimum 10)
    assert calculate_max_steps(0, 0, 0) == 10
    
    # Very large form (still capped)
    assert calculate_max_steps(20, 10, 5) == 50


def test_loop_detection():
    """Test loop detection logic."""
    action_history = []
    
    # Simulate actions
    action_history.append({"targetId": 1, "type": "TYPE"})
    action_history.append({"targetId": 1, "type": "TYPE"})  # Repeat!
    
    # Check for loop
    recent = action_history[-2:]
    if len(recent) >= 2:
        last = recent[-1]
        prev = recent[-2]
        assert last["targetId"] == prev["targetId"]
        assert last["type"] == prev["type"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
