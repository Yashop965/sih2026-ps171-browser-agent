"""
LLM Client Factory
==================
Creates appropriate LLM client based on configuration.
"""

from typing import Optional
from .base import BaseLLMClient
from .custom_endpoint import CustomEndpointClient, MultiProviderRouter
from .ollama_client import OllamaClient, OllamaFallbackClient


def create_llm_client(
    provider: str = "auto",
    api_url: Optional[str] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> BaseLLMClient:
    """
    Create LLM client based on configuration.
    
    Args:
        provider: 'custom', 'ollama', or 'auto' (default)
        api_url: Custom API endpoint URL
        api_key: Custom API key
        model: Model name to use
    
    Returns:
        Configured LLM client
    
    Examples:
        # Use custom endpoint only
        client = create_llm_client(provider="custom", api_url="...", api_key="...")
        
        # Use Ollama only
        client = create_llm_client(provider="ollama", model="qwen2.5:1.5b")
        
        # Auto: Try custom, fallback to Ollama
        client = create_llm_client(provider="auto", api_url="...", api_key="...")
    """
    
    if provider == "custom":
        return CustomEndpointClient(api_url=api_url, api_key=api_key, model=model)
    
    elif provider == "ollama":
        return OllamaClient(model=model)
    
    elif provider == "auto":
        # Try custom endpoint first, fallback to Ollama
        try:
            custom = CustomEndpointClient(api_url=api_url, api_key=api_key, model=model)
            return OllamaFallbackClient(primary_client=custom)
        except ValueError:
            # No custom config, use Ollama only
            return OllamaClient(model=model)
    
    else:
        raise ValueError(f"Unknown provider: {provider}. Use 'custom', 'ollama', or 'auto'.")


def get_default_provider() -> str:
    """Determine default provider based on environment."""
    if os.getenv("LLM_API_URL") and os.getenv("LLM_API_KEY"):
        return "custom"
    return "ollama"


import os
