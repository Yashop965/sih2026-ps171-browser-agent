"""
LLM Client Interface
====================
Abstract base class for all LLM providers.
Ensures consistent API regardless of backend.
"""

from abc import ABC, abstractmethod
from typing import Optional, Dict, Any


class BaseLLMClient(ABC):
    """
    Abstract interface for LLM clients.
    All providers (Custom API, Ollama, etc.) must implement this.
    """
    
    @abstractmethod
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        """
        Generate text response from LLM.
        
        Args:
            prompt: User prompt with page context
            system_prompt: Optional system instruction
        
        Returns:
            Raw text response from LLM (should contain JSON action)
        """
        pass
    
    @abstractmethod
    async def health_check(self) -> Dict[str, Any]:
        """
        Check if the LLM service is available.
        
        Returns:
            Dict with 'healthy': bool and optional 'latency_ms': float
        """
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Human-readable name of the provider."""
        pass
    
    @property
    @abstractmethod
    def model_name(self) -> str:
        """Name of the model being used."""
        pass
