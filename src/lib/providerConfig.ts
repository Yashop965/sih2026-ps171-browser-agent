// Provider configuration for multi-backend support
export interface ProviderConfig {
  name: string;
  label: string;
  url: string;
  model?: string;
  apiKey?: string;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  custom: {
    name: 'custom',
    label: 'Custom (Agnes AI)',
    url: 'https://apihub.agnes-ai.com/v1',
    model: 'agnes-2.5-flash',
    apiKey: '',
  },
  ollama: {
    name: 'ollama',
    label: 'Ollama (Local)',
    url: 'http://localhost:11434',
    model: 'qwen2.5:1.5b',
    apiKey: '',
  },
  groq: {
    name: 'groq',
    label: 'Groq',
    url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    apiKey: '',
  },
  openrouter: {
    name: 'openrouter',
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3-haiku',
    apiKey: '',
  },
};

export type ProviderKey = keyof typeof PROVIDERS;

export function getDefaultProvider(): ProviderKey {
  return 'custom';
}

export function getProvider(key: ProviderKey): ProviderConfig {
  return PROVIDERS[key] || PROVIDERS.custom;
}

export function isProviderConfigured(config: Partial<ProviderConfig>): boolean {
  if (!config.url) return false;
  // Local providers don't need API key
  if (config.url.includes('localhost') || config.url.includes('127.0.0.1')) {
    return true;
  }
  return !!config.apiKey;
}
