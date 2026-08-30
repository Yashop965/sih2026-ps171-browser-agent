"""
Test module for UACC integration
"""
import asyncio
from server.action_executor import ActionExecutor, ActionResult, ActionType


async def test_mock_executor():
    """Test executor without UACC connection (mock mode)."""
    executor = ActionExecutor(cdp_port=9999)  # Non-existent port
    
    # Test click
    result = await executor.execute_action(ActionType.CLICK.value, target_id=1)
    print(f"Click: {result}")
    assert result.success
    assert result.action_type == ActionType.CLICK.value
    
    # Test type
    result = await executor.execute_action(ActionType.TYPE.value, target_id=2, text="Hello World")
    print(f"Type: {result}")
    assert result.success
    assert result.action_type == ActionType.TYPE.value
    
    # Test scroll
    result = await executor.execute_action(ActionType.SCROLL.value, direction='down', amount=300)
    print(f"Scroll: {result}")
    assert result.success
    
    # Test navigate
    result = await executor.execute_action(ActionType.NAVIGATE.value, text="https://example.com")
    print(f"Navigate: {result}")
    assert result.success
    
    # Test wait
    result = await executor.execute_action(ActionType.WAIT.value, condition='100')
    print(f"Wait: {result}")
    assert result.success
    
    await executor.close()
    print("All mock tests passed!")


if __name__ == "__main__":
    asyncio.run(test_mock_executor())
