# Multi-Provider LLM Architecture

## Overview

This project now supports multiple LLM inference providers with automatic fallback:

1. **Custom Endpoints** (Primary) - Any OpenAI-compatible API (Groq, Together AI, etc.)
2. **Ollama** (Fallback) - Local LLM inference
3. **Mock Client** (Testing) - For development without API keys

## Architecture

```
server/
├── llm_clients/
│   ├── base.py              # Abstract interface
│   ├── custom_endpoint.py   # OpenAI-compatible API client
│   ├── ollama_client.py     # Local Ollama client + fallback
│   └── __init__.py          # Factory function
├── planner.py               # Uses LLM clients
└── main.py                  # Configuration
```

## Quick Start

### 1. Using Custom API (Recommended for Production)

Create a `.env` file in the `server/` directory:

```bash
# server/.env
LLM_PROVIDER=custom
LLM_API_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_your_api_key_here
LLM_MODEL=llama-3.1-8b-instant
```

### 2. Using Ollama Only (Local Development)

```bash
# server/.env
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5:1.5b
```

### 3. Using Auto Fallback (Recommended)

```bash
# server/.env
LLM_PROVIDER=auto
LLM_API_URL=https://api.groq.com/openai/v1
LLM_API_KEY=gsk_your_api_key_here
OLLAMA_MODEL=qwen2.5:1.5b
```

This tries the custom API first, falls back to Ollama if unavailable.

## Configuration Options

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `LLM_PROVIDER` | Provider selection: `auto`, `custom`, or `ollama` | `auto` | No |
| `LLM_API_URL` | Custom API endpoint URL | - | Yes (for custom) |
| `LLM_API_KEY` | Custom API key | - | Yes (for custom) |
| `LLM_MODEL` | Model name for custom API | `llama-3.1-8b-instant` | No |
| `OLLAMA_HOST` | Ollama server URL | `http://localhost:11434` | No |
| `OLLAMA_MODEL` | Ollama model name | `qwen2.5:1.5b` | No |

## Supported Providers

### Custom Endpoints (OpenAI-compatible)
- **Groq** (`api.groq.com`) - Fast inference, free tier available
- **OpenRouter** (`openrouter.ai`) - Multiple models
- **Together AI** (`api.together.xyz`) - Open source models
- **Any OpenAI-compatible API**

### Local Options
- **Ollama** - Run models locally (Qwen2.5, Llama, Mistral, etc.)
- **Mock Client** - For testing without real API calls

## Code Example

### Basic Usage
```python
from server.llm_clients import create_llm_client

# Create client with auto-fallback
client = create_llm_client(
    provider="auto",
    api_url="https://api.groq.com/openai/v1",
    api_key="gsk_xxxxxxxx",
    model="llama-3.1-8b-instant"
)

# Generate response
response = await client.generate(prompt="What is the next action?")

# Check health
health = await client.health_check()
print(f"Healthy: {health['healthy']}")
```

### Using with Planner
```python
from server.planner import ActionPlanner

# Create planner with custom LLM
planner = ActionPlanner(
    provider="auto",
    api_url="...",
    api_key="..."
)

# Plan action
result = await planner.plan(
    url="https://example.com",
    title="Example",
    interactive_elements=[],
    accessibility_tree=[],
    task_description="Fill the form"
)
```

## Adding New Providers

To add a new LLM provider:

1. Create a new file in `server/llm_clients/`
2. Implement the `BaseLLMClient` interface:
```python
from server.llm_clients.base import BaseLLMClient

class MyCustomClient(BaseLLMClient):
    @property
    def name(self) -> str:
        return "my_custom_provider"
    
    @property
    def model_name(self) -> str:
        return self.model
    
    async def generate(self, prompt: str, system_prompt: str = "") -> str:
        # Your implementation
        pass
    
    async def health_check(self) -> Dict[str, Any]:
        # Return health status
        pass
```

3. Update `__init__.py` to include the new provider

## Testing

### Run Python Tests
```bash
cd server
python -m pytest tests/test_fastapi_planner.py -v
```

### Test LLM Client Creation
```python
import asyncio
from server.llm_clients import create_llm_client

# Test Ollama
client = create_llm_client(provider="ollama")
print(client.name)  # "ollama"

# Test auto-fallback
client = create_llm_client(provider="auto")
print(client.name)  # "ollama_with_ollama_fallback"
```

## Troubleshooting

### "CustomEndpointClient requires LLM_API_URL and LLM_API_KEY"
- Set both `LLM_API_URL` and `LLM_API_KEY` environment variables
- Or use `LLM_PROVIDER=ollama` instead

### "Ollama connection refused"
- Start Ollama: `ollama serve`
- Pull model: `ollama pull qwen2.5:1.5b`
- Verify running: `curl http://localhost:11434/api/tags`

### "All LLM providers failed"
- Check logs for specific error messages
- Verify API keys are valid
- Ensure Ollama is running (if using fallback)

## Performance Notes

- Custom API timeout: 30 seconds
- Ollama timeout: 60 seconds
- Temperature: 0.1 (deterministic output)
- Max tokens: 500

## Security

- API keys are read from environment variables, never hardcoded
- Health checks don't expose sensitive information
- Error messages are generic (no internal details leaked)
- Use HTTPS for all API endpoints

## Migration from Old Architecture

If you were using the old single-provider system:

1. **No code changes needed** - The interface is backward compatible
2. **Optional**: Update your deployment to use environment variables
3. **Recommended**: Test with both providers before competition

### Old Way (Still Works)
```python
from server.planner import ActionPlanner

# This still works
planner = ActionPlanner(llm_client=my_custom_client)
```

### New Way (Recommended)
```python
from server.planner import ActionPlanner

# Cleaner configuration
planner = ActionPlanner(provider="auto", api_url="...", api_key="...")
```

## Competition Setup

For SIH 2026 competition:

1. **Primary**: Use Groq or similar fast API
2. **Fallback**: Have Ollama running locally
3. **Backup**: Mock client for offline demos

Example deployment script:
```bash
#!/bin/bash
# Start Ollama fallback
ollama serve &

# Set environment
export LLM_PROVIDER=auto
export LLM_API_URL=https://api.groq.com/openai/v1
export LLM_API_KEY=$GROQ_API_KEY

# Start server
python server/main.py
```

## Resources

- [Groq API Documentation](https://console.groq.com/docs)
- [Ollama Documentation](https://ollama.ai/docs)
- [OpenAI API Compatibility](https://platform.openai.com/docs/api-reference)

---

*Last updated: September 1, 2026*
*Version: 2.0*
