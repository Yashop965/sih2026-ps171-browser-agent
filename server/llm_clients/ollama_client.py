"""
Ollama LLM Client
=================
Local LLM inference via Ollama API.
Used as fallback when custom endpoint is unavailable.
"""

import os
import httpx
from typing import Optional, Dict, Any
from .base import BaseLLMClient


class OllamaClient(BaseLLMClient):
    """
    LLM client for local Ollama instances.
    
    Environment variables:
        OLLAMA_HOST: Ollama server URL (default: http://localhost:11434)
        OLLAMA_MODEL: Model name (default: qwen2.5:1.5b)
    """
    
    def __init__(
        self,
        host: Optional[str] = None,
        model: Optional[str] = None,
    ):
        self.host = (host or os.getenv("OLLAMA_HOST", "http://localhost:11434")).rstrip("/")
        self.model = model or os.getenv("OLLAMA_MODEL", "qwen2.5:1.5b")
    
    @property
    def name(self) -> str:
        return "ollama"
    
    @property
    def model_name(self) -> str:
        return self.model
    
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        """
        Call Ollama generate endpoint.
        
        Expects: POST /api/generate
        """
        url = f"{self.host}/api/generate"
        
        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.1,
                "num_predict": 500,
            },
        }
        
        if system_prompt:
            payload["system"] = system_prompt
        
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, json=payload)
            response.raise_for_status()
            
            data = response.json()
            return data.get("response", "")
    
    async def health_check(self) -> Dict[str, Any]:
        """Check if Ollama is running."""
        try:
            url = f"{self.host}/api/tags"
            
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(url)
                response.raise_for_status()
                
                data = response.json()
                models = [m["name"] for m in data.get("models", [])]
                
                return {
                    "healthy": True,
                    "provider": "ollama",
                    "model": self.model,
                    "available_models": models[:5],  # Show first 5
                }
        except Exception as e:
            return {"healthy": False, "error": str(e)}
    
    def format_prompt(self, prompt: str) -> str:
        """Ollama doesn't need special formatting."""
        return prompt


class OllamaFallbackClient:
    """
    Wrapper that provides Ollama as a fallback when primary client fails.
    """
    
    def __init__(self, primary_client: BaseLLMClient, ollama_client: Optional[OllamaClient] = None):
        self.primary = primary_client
        self.fallback = ollama_client or OllamaClient()
    
    @property
    def name(self) -> str:
        return f"{self.primary.name}_with_ollama_fallback"
    
    @property
    def model_name(self) -> str:
        return f"{self.primary.model_name} -> {self.fallback.model_name}"
    
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        """Try primary first, fall back to Ollama."""
        try:
            return await self.primary.generate(prompt, system_prompt)
        except Exception as e:
            print(f"[LLM] Primary provider {self.primary.name} failed: {e}")
            print(f"[LLM] Falling back to Ollama...")
            return await self.fallback.generate(prompt, system_prompt)
    
    async def health_check(self) -> Dict[str, Any]:
        """Check health of both providers."""
        primary_health = await self.primary.health_check()
        fallback_health = await self.fallback.health_check()
        
        return {
            "primary": primary_health,
            "fallback": fallback_health,
            "available": primary_health.get("healthy", False) or fallback_health.get("healthy", False),
        }
