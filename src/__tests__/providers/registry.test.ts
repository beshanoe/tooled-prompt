import { describe, it, expect } from 'vitest';
import { OpenAIProvider } from '../../providers/openai.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { getProvider } from '../../providers/index.js';
import { parseDataUrl } from '../../providers/utils.js';

describe('parseDataUrl', () => {
  it('parses valid data URL', () => {
    const result = parseDataUrl('data:image/jpeg;base64,ABC123');
    expect(result).toEqual({ mediaType: 'image/jpeg', base64: 'ABC123' });
  });

  it('parses data URL with png', () => {
    const result = parseDataUrl('data:image/png;base64,XYZ789');
    expect(result).toEqual({ mediaType: 'image/png', base64: 'XYZ789' });
  });

  it('throws on invalid data URL', () => {
    expect(() => parseDataUrl('https://example.com/img.jpg')).toThrow('Invalid data URL');
  });

  it('throws on malformed data URL', () => {
    expect(() => parseDataUrl('data:image/jpeg,notbase64')).toThrow('Invalid data URL');
  });
});

describe('getProvider', () => {
  it('returns OpenAI provider', () => {
    expect(getProvider('openai')).toBeInstanceOf(OpenAIProvider);
  });

  it('returns Anthropic provider', () => {
    expect(getProvider('anthropic')).toBeInstanceOf(AnthropicProvider);
  });

  it('returns Ollama provider', () => {
    expect(getProvider('ollama')).toBeInstanceOf(OllamaProvider);
  });

  it('throws for unknown provider', () => {
    expect(() => getProvider('unknown')).toThrow('Unknown provider: "unknown"');
  });
});
