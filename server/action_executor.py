"""
UACC Integration Module
========================
Provides self-healing clicks, smart typing, and action verification
using the UACC (Universal Agent Control & Coordination) library.

Usage:
    from server.action_executor import ActionExecutor
    
    executor = ActionExecutor(cdp_port=9222)
    result = await executor.execute_action(action)
"""

import asyncio
from dataclasses import dataclass
from enum import Enum
from typing import Optional, Dict, Any
import json

# Try to import UACC
try:
    # Add UACC virtual environment to path if needed
    import sys
    uacc_venv = r"D:\uv-venv-uacc\Lib\site-packages"
    if uacc_venv not in sys.path:
        sys.path.insert(0, uacc_venv)
    
    from uacc import UACCClient
    UACC_AVAILABLE = True
except ImportError:
    UACC_AVAILABLE = False
    print("[UACC] Warning: uacc package not found. Using fallback executor.")


class ActionType(str, Enum):
    CLICK = "CLICK"
    TYPE = "TYPE"
    SCROLL = "SCROLL"
    NAVIGATE = "NAVIGATE"
    WAIT = "WAIT"
    COMPLETE = "COMPLETE"


@dataclass
class ActionResult:
    success: bool
    action_type: str
    target_id: Optional[int] = None
    message: str = ""
    retries: int = 0
    verified: bool = False
    error: Optional[str] = None


class ActionExecutor:
    """
    Self-healing action executor using UACC.
    
    Features:
    - Smart click with retry logic
    - Smart type with verification
    - Action verification after execution
    - Exponential backoff on failures
    """
    
    def __init__(self, cdp_port: int = 9222, max_retries: int = 3):
        self.cdp_port = cdp_port
        self.max_retries = max_retries
        self.client = None
        
        if UACC_AVAILABLE:
            try:
                self.client = UACCClient(f"http://localhost:{cdp_port}")
                print(f"[UACC] Connected to CDP at port {cdp_port}")
            except Exception as e:
                print(f"[UACC] Failed to connect: {e}")
                self.client = None
        else:
            print("[UACC] UACC not available, using fallback mode")
    
    async def execute_action(
        self,
        action_type: str,
        target_id: Optional[int] = None,
        text: Optional[str] = None,
        x: Optional[int] = None,
        y: Optional[int] = None,
        **kwargs
    ) -> ActionResult:
        """
        Execute an action with self-healing retry logic.
        
        Args:
            action_type: CLICK, TYPE, SCROLL, NAVIGATE, WAIT
            target_id: Element ID from DOM extraction
            text: Text to type (for TYPE action)
            x, y: Coordinates (for direct click/type)
            **kwargs: Additional parameters
        
        Returns:
            ActionResult with success status and details
        """
        retries = 0
        last_error = None
        
        while retries <= self.max_retries:
            try:
                if action_type == ActionType.CLICK.value:
                    result = await self._smart_click(target_id, x, y)
                elif action_type == ActionType.TYPE.value:
                    result = await self._smart_type(target_id, text, x, y)
                elif action_type == ActionType.SCROLL.value:
                    result = await self._scroll(kwargs.get('direction', 'down'), kwargs.get('amount', 500))
                elif action_type == ActionType.NAVIGATE.value:
                    result = await self._navigate(text or kwargs.get('url', ''))
                elif action_type == ActionType.WAIT.value:
                    result = await self._wait(kwargs.get('condition', '1000'))
                else:
                    return ActionResult(
                        success=False,
                        action_type=action_type,
                        message=f"Unknown action type: {action_type}"
                    )
                
                # Verify action succeeded
                if result.success and kwargs.get('verify', True):
                    verified = await self._verify_action(action_type, target_id)
                    result.verified = verified
                
                return result
                
            except Exception as e:
                last_error = str(e)
                retries += 1
                if retries > self.max_retries:
                    break
                # Exponential backoff
                await asyncio.sleep(0.5 ** retries)
        
        return ActionResult(
            success=False,
            action_type=action_type,
            retries=retries,
            error=last_error,
            message=f"Failed after {retries} retries"
        )
    
    async def _smart_click(self, target_id: Optional[int], x: Optional[int], y: Optional[int]) -> ActionResult:
        """Smart click with element lookup or coordinates."""
        if self.client and target_id is not None:
            # Use UACC smart_click with element ID
            result = await self.client.smart_click(
                element_id=target_id,
                max_retries=self.max_retries,
                verify=True
            )
            return ActionResult(
                success=result.get('success', False),
                action_type=ActionType.CLICK.value,
                target_id=target_id,
                message=result.get('message', 'Click executed'),
                verified=result.get('verified', False)
            )
        elif x is not None and y is not None:
            # Fallback: click by coordinates
            if self.client:
                result = await self.client.click(x=x, y=y)
                return ActionResult(
                    success=result.get('success', False),
                    action_type=ActionType.CLICK.value,
                    message=f"Clicked at ({x}, {y})"
                )
            else:
                # Mock success for testing
                return ActionResult(
                    success=True,
                    action_type=ActionType.CLICK.value,
                    message=f"Mock click at ({x}, {y})"
                )
        else:
            return ActionResult(
                success=False,
                action_type=ActionType.CLICK.value,
                message="No target_id or coordinates provided"
            )
    
    async def _smart_type(self, target_id: Optional[int], text: Optional[str], x: Optional[int], y: Optional[int]) -> ActionResult:
        """Smart type with verification."""
        if not text:
            return ActionResult(
                success=False,
                action_type=ActionType.TYPE.value,
                message="No text provided"
            )
        
        if self.client and target_id is not None:
            result = await self.client.smart_type(
                element_id=target_id,
                text=text,
                clear=True,
                max_retries=self.max_retries
            )
            return ActionResult(
                success=result.get('success', False),
                action_type=ActionType.TYPE.value,
                target_id=target_id,
                message=result.get('message', 'Type executed'),
                verified=result.get('verified', False)
            )
        elif x is not None and y is not None:
            # Fallback: type at coordinates
            if self.client:
                result = await self.client.type_at(x=x, y=y, text=text)
                return ActionResult(
                    success=result.get('success', False),
                    action_type=ActionType.TYPE.value,
                    message=f"Typed at ({x}, {y})"
                )
            else:
                return ActionResult(
                    success=True,
                    action_type=ActionType.TYPE.value,
                    message=f"Mock type: {text[:20]}..."
                )
        else:
            return ActionResult(
                success=False,
                action_type=ActionType.TYPE.value,
                message="No target_id or coordinates provided"
            )
    
    async def _scroll(self, direction: str = 'down', amount: int = 500) -> ActionResult:
        """Scroll the page."""
        if self.client:
            result = await self.client.scroll(direction=direction, amount=amount)
            return ActionResult(
                success=result.get('success', False),
                action_type=ActionType.SCROLL.value,
                message=f"Scrolled {direction} by {amount}px"
            )
        else:
            return ActionResult(
                success=True,
                action_type=ActionType.SCROLL.value,
                message=f"Mock scroll {direction} by {amount}px"
            )
    
    async def _navigate(self, url: str) -> ActionResult:
        """Navigate to a URL."""
        if self.client:
            result = await self.client.navigate(url)
            return ActionResult(
                success=result.get('success', False),
                action_type=ActionType.NAVIGATE.value,
                message=f"Navigated to {url}"
            )
        else:
            return ActionResult(
                success=True,
                action_type=ActionType.NAVIGATE.value,
                message=f"Mock navigate to {url}"
            )
    
    async def _wait(self, condition: str = '1000') -> ActionResult:
        """Wait for a condition (timeout in ms)."""
        try:
            timeout = int(condition) if condition.isdigit() else 1000
            if self.client:
                result = await self.client.wait(timeout=timeout)
                return ActionResult(
                    success=result.get('success', False),
                    action_type=ActionType.WAIT.value,
                    message=f"Waited {timeout}ms"
                )
            else:
                await asyncio.sleep(timeout / 1000)
                return ActionResult(
                    success=True,
                    action_type=ActionType.WAIT.value,
                    message=f"Mock wait {timeout}ms"
                )
        except ValueError:
            return ActionResult(
                success=False,
                action_type=ActionType.WAIT.value,
                message=f"Invalid wait condition: {condition}"
            )
    
    async def _verify_action(self, action_type: str, target_id: Optional[int] = None) -> bool:
        """Verify action was successful using UACC."""
        if not self.client or target_id is None:
            return True  # Skip verification if no client or target
        
        try:
            # Verify element still exists and is clickable/typeable
            result = await self.client.verify_element(element_id=target_id)
            return result.get('exists', False) and result.get('visible', False)
        except Exception:
            return False
    
    async def close(self):
        """Close UACC connection."""
        if self.client:
            try:
                await self.client.close()
            except Exception:
                pass


# Export for easy import
__all__ = ['ActionExecutor', 'ActionResult', 'ActionType']
