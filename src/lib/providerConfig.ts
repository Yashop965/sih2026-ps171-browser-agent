// Provider configuration for multi-backend support
export interface ProviderConfig {
  name: string;
  label: string;
  url: string;
  model?: string;
  apiKey?: string; // Stored in chrome.storage, not hardcoded
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  custom: {
    name: 'custom',
    label: 'Custom (Agnes AI)',
    url: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.5-flash',
  },
  ollama: {
    name: 'ollama',
    label: 'Ollama (Local)',
    url: 'http://localhost:11434',
    model: 'qwen2.5:1.5b',
  },
  groq: {
    name: 'groq',
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
  },
  openrouter: {
    name: 'openrouter',
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3-haiku',
  },
};

export type ProviderKey = keyof typeof PROVIDERS;

export function getDefaultProvider(): ProviderKey {
  return 'custom';
}

export function getProvider(key: ProviderKey): ProviderConfig {
  return PROVIDERS[key] || PROVIDERS.custom;
}
