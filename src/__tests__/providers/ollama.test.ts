import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../../providers/ollama.js';
import { TooledPromptEmitter } from '../../events.js';
import type { ToolMetadata, ContentPart } from '../../types.js';

const sampleTool: ToolMetadata = {
  name: 'greet',
  description: 'Greet a person',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Name to greet' } },
    required: ['name'],
  },
};

describe('OllamaProvider', () => {
  const provider = new OllamaProvider();
  let emitter: TooledPromptEmitter;

  beforeEach(() => {
    emitter = new TooledPromptEmitter();
  });

  describe('buildRequest', () => {
    it('builds correct URL', () => {
      const { url } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(url).toBe('http://localhost:11434/api/chat');
    });

    it('does not include auth headers', () => {
      const { headers } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(headers['Authorization']).toBeUndefined();
      expect(headers['x-api-key']).toBeUndefined();
    });

    it('uses OpenAI-style tool format', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [], tools: [sampleTool], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect((body.tools as any[])[0]).toEqual({
        type: 'function',
        function: { name: 'greet', description: 'Greet a person', parameters: sampleTool.parameters },
      });
    });

    it('puts temperature in options', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [], tools: [], stream: false, temperature: 0.5, maxTokens: undefined,
      });
      expect((body.options as any).temperature).toBe(0.5);
    });

    it('puts schema directly in format field', () => {
      const schema = { type: 'object', properties: { name: { type: 'string' } } };
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
        schema: { jsonSchema: schema },
      });
      expect(body.format).toEqual(schema);
    });

    it('prepends system message from systemPrompt', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost:11434', apiKey: undefined, modelName: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }], tools: [], stream: false,
        temperature: undefined, maxTokens: undefined, systemPrompt: 'You are helpful.',
      });
      const messages = body.messages as any[];
      expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
      expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
    });
  });

  describe('formatUserMessage', () => {
    it('formats plain string', () => {
      expect(provider.formatUserMessage('Hello')).toEqual({ role: 'user', content: 'Hello' });
    });

    it('extracts base64 images from content parts', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Describe this:' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ABC123' } },
      ];
      const result = provider.formatUserMessage(parts) as any;
      expect(result.role).toBe('user');
      expect(result.content).toBe('Describe this:');
      expect(result.images).toEqual(['ABC123']);
    });

    it('prepends system images as base64', () => {
      const images: ContentPart[] = [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SYS_IMG' } },
      ];
      const result = provider.formatUserMessage('Hello', images) as any;
      expect(result.images).toEqual(['SYS_IMG']);
    });
  });

  describe('formatAssistantMessage', () => {
    it('formats content only', () => {
      expect(provider.formatAssistantMessage('Hello', [])).toEqual({
        role: 'assistant', content: 'Hello',
      });
    });

    it('formats with tool calls (parsed arguments)', () => {
      const result = provider.formatAssistantMessage('', [{
        id: 'ollama_0', name: 'greet', arguments: '{"name":"World"}',
      }]) as any;
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls[0].function.name).toBe('greet');
      expect(result.tool_calls[0].function.arguments).toEqual({ name: 'World' });
    });
  });

  describe('formatToolResults', () => {
    it('formats as simple tool role messages', () => {
      const results = provider.formatToolResults([
        { id: 'ollama_0', name: 'greet', result: 'Hello!' },
      ]);
      expect(results).toEqual([{ role: 'tool', content: 'Hello!' }]);
    });
  });

  describe('parseResponse', () => {
    it('parses non-streaming response', async () => {
      const response = {
        json: async () => ({ message: { content: 'Hello World', role: 'assistant' } }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.content).toBe('Hello World');
      expect(result.toolCalls).toEqual([]);
    });

    it('parses non-streaming response with tool calls', async () => {
      const response = {
        json: async () => ({
          message: {
            content: '',
            tool_calls: [{ function: { name: 'greet', arguments: { name: 'World' } } }],
          },
        }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe('greet');
      expect(result.toolCalls[0].arguments).toBe('{"name":"World"}');
    });

    it('parses NDJSON streaming response', async () => {
      const encoder = new TextEncoder();
      let index = 0;
      const lines = [
        '{"message":{"role":"assistant","content":"Hello"},"done":false}\n',
        '{"message":{"role":"assistant","content":" World"},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true}\n',
      ];
      const body = {
        getReader: () => ({
          read: async () => {
            if (index < lines.length) {
              return { done: false, value: encoder.encode(lines[index++]) };
            }
            return { done: true, value: undefined };
          },
        }),
      };

      const response = { ok: true, body } as unknown as Response;
      const contentHandler = vi.fn();
      emitter.on('content', contentHandler);

      const result = await provider.parseResponse(response, true, emitter);
      expect(result.content).toBe('Hello World');
      expect(contentHandler).toHaveBeenCalledWith('Hello');
      expect(contentHandler).toHaveBeenCalledWith(' World');
    });

    it('throws when no message', async () => {
      const response = { json: async () => ({}), body: null } as unknown as Response;
      await expect(provider.parseResponse(response, false, emitter)).rejects.toThrow('No response from LLM');
    });
  });
});
