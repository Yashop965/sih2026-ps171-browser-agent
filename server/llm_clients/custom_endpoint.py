"""
Custom Endpoint LLM Client
===========================
Connects to any OpenAI-compatible API endpoint.
Use this for custom inference providers (Groq, Together AI, self-hosted, etc.)
"""

import os
import json
import httpx
from typing import Optional, Dict, Any
from .base import BaseLLMClient


class CustomEndpointClient(BaseLLMClient):
    """
    LLM client for custom OpenAI-compatible endpoints.
    
    Environment variables:
        LLM_API_URL: Base URL of the API (e.g., https://api.groq.com/openai/v1)
        LLM_API_KEY: API key for authentication
        LLM_MODEL: Model name (e.g., llama-3.1-8b-instant)
    """
    
    def __init__(
        self,
        api_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.api_url = (api_url or os.getenv("LLM_API_URL", "")).rstrip("/")
        self.api_key = api_key or os.getenv("LLM_API_KEY", "")
        self.model = model or os.getenv("LLM_MODEL", "llama-3.1-8b-instant")
        
        # Validate configuration
        if not self.api_url or not self.api_key:
            raise ValueError(
                "CustomEndpointClient requires LLM_API_URL and LLM_API_KEY "
                "either as constructor args or environment variables"
            )
    
    @property
    def name(self) -> str:
        return "custom_endpoint"
    
    @property
    def model_name(self) -> str:
        return self.model
    
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        """
        Call custom OpenAI-compatible endpoint.
        
        Expects endpoint to support: POST /chat/completions
        """
        url = f"{self.api_url}/chat/completions"
        
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt or "You are a helpful assistant."},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,  # Low temperature for deterministic output
            "max_tokens": 500,
        }
        
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            
            data = response.json()
            return data["choices"][0]["message"]["content"]
    
    async def health_check(self) -> Dict[str, Any]:
        """Check if custom endpoint is reachable."""
        try:
            url = f"{self.api_url}/models"
            headers = {"Authorization": f"Bearer {self.api_key}"}
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                return {"healthy": True, "provider": "custom_endpoint", "model": self.model}
        except Exception as e:
            return {"healthy": False, "error": str(e)}
    
    def format_prompt(self, prompt: str) -> str:
        """Optional: Pre-process prompt before sending."""
        return prompt


class MultiProviderRouter:
    """
    Routes requests to multiple LLM providers with fallback.
    
    Usage:
        router = MultiProviderRouter([
            CustomEndpointClient(api_url="...", api_key="..."),
            OllamaClient(),  # fallback
        ])
        response = await router.generate(prompt)
    """
    
    def __init__(self, clients: list):
        self.clients = clients
        self.current_client_idx = 0
    
    @property
    def name(self) -> str:
        return "multi_provider_router"
    
    @property
    def model_name(self) -> str:
        if self.clients:
            return f"{' -> '.join(c.model_name for c in self.clients)}"
        return "none"
    
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        """
        Try each client in order until one succeeds.
        """
        last_error = None
        
        for i, client in enumerate(self.clients):
            try:
                # Skip unhealthy clients
                health = await client.health_check()
                if not health.get("healthy", False):
                    continue
                
                response = await client.generate(prompt, system_prompt)
                
                # Rotate to next client for load balancing (optional)
                self.current_client_idx = (i + 1) % len(self.clients)
                
                return response
                
            except Exception as e:
                last_error = e
                continue
        
        # All clients failed
        raise RuntimeError(
            f"All LLM providers failed. Last error: {last_error}"
        )
    
    async def health_check(self) -> Dict[str, Any]:
        """Check health of all providers."""
        results = {}
        for client in self.clients:
            results[client.name] = await client.health_check()
        return results
