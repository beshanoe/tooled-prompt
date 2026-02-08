/**
 * Provider registry
 *
 * Maps provider names to their adapter implementations.
 */

import type { ProviderAdapter } from './types.js';
import { OpenAIProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';

const providers: Record<string, ProviderAdapter> = {
  openai: new OpenAIProvider(),
  anthropic: new AnthropicProvider(),
  ollama: new OllamaProvider(),
};

export function getProvider(name: string): ProviderAdapter {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown provider: "${name}". Available: ${Object.keys(providers).join(', ')}`);
  return provider;
}

export function registerProvider(name: string, adapter: ProviderAdapter): void {
  providers[name] = adapter;
}

// Re-export types and classes for advanced users
export type { ProviderAdapter, ToolCallInfo, ToolResultInfo, ParsedResponse, BuildRequestParams, BuildRequestResult } from './types.js';
export { OpenAIProvider } from './openai.js';
export { AnthropicProvider } from './anthropic.js';
export { OllamaProvider } from './ollama.js';
export { parseDataUrl, toolsToOpenAIFormat } from './utils.js';
