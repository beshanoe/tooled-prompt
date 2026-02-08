import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAIProvider } from '../../providers/openai.js';
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

function createMockSSEStream(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index < chunks.length) {
          return { done: false, value: encoder.encode(chunks[index++]) };
        }
        return { done: true, value: undefined };
      },
    }),
  };
}

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider();
  let emitter: TooledPromptEmitter;

  beforeEach(() => {
    emitter = new TooledPromptEmitter();
  });

  describe('buildRequest', () => {
    it('builds correct URL', () => {
      const { url } = provider.buildRequest({
        apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('includes Authorization header', () => {
      const { headers } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: 'sk-test', modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(headers['Authorization']).toBe('Bearer sk-test');
    });

    it('omits Authorization when no apiKey', () => {
      const { headers } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(headers['Authorization']).toBeUndefined();
    });

    it('includes tools in OpenAI format', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [sampleTool], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(body.tools).toEqual([{
        type: 'function',
        function: { name: 'greet', description: 'Greet a person', parameters: sampleTool.parameters },
      }]);
      expect(body.tool_choice).toBe('auto');
    });

    it('omits tools when empty', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    });

    it('includes temperature when set', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: 0.7, maxTokens: undefined,
      });
      expect(body.temperature).toBe(0.7);
    });

    it('includes max_tokens when set', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: 1024,
      });
      expect(body.max_tokens).toBe(1024);
    });

    it('includes schema as response_format', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
        schema: { jsonSchema: { type: 'object', properties: { name: { type: 'string' } } } },
      });
      expect(body.response_format).toEqual({
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
        },
      });
    });

    it('omits response_format when no schema', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(body.response_format).toBeUndefined();
    });

    it('prepends system message when systemPrompt provided', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'http://localhost', apiKey: undefined, modelName: 'gpt-4',
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

    it('formats content parts', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Hello' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ];
      expect(provider.formatUserMessage(parts)).toEqual({ role: 'user', content: parts });
    });

    it('prepends images to string content', () => {
      const images: ContentPart[] = [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
      ];
      const result = provider.formatUserMessage('Hello', images) as any;
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('image_url');
      expect(result.content[1]).toEqual({ type: 'text', text: 'Hello' });
    });
  });

  describe('formatAssistantMessage', () => {
    it('formats content only', () => {
      expect(provider.formatAssistantMessage('Hello', [])).toEqual({
        role: 'assistant', content: 'Hello', tool_calls: undefined,
      });
    });

    it('formats with tool calls', () => {
      const result = provider.formatAssistantMessage('', [{
        id: 'call_1', name: 'greet', arguments: '{"name":"World"}',
      }]) as any;
      expect(result.tool_calls[0]).toEqual({
        id: 'call_1', type: 'function',
        function: { name: 'greet', arguments: '{"name":"World"}' },
      });
    });
  });

  describe('formatToolResults', () => {
    it('formats results as tool messages', () => {
      const results = provider.formatToolResults([
        { id: 'call_1', name: 'greet', result: 'Hello, World!' },
      ]);
      expect(results).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: 'Hello, World!' }]);
    });
  });

  describe('parseResponse', () => {
    it('parses non-streaming response', async () => {
      const response = {
        json: async () => ({ choices: [{ message: { content: 'Hello', tool_calls: [] } }] }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.content).toBe('Hello');
      expect(result.toolCalls).toEqual([]);
    });

    it('parses non-streaming response with tool calls', async () => {
      const response = {
        json: async () => ({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'greet', arguments: '{"name":"World"}' } }],
            },
          }],
        }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'greet', arguments: '{"name":"World"}' }]);
    });

    it('throws when no choices', async () => {
      const response = { json: async () => ({ choices: [] }), body: null } as unknown as Response;
      await expect(provider.parseResponse(response, false, emitter)).rejects.toThrow('No response from LLM');
    });

    it('parses streaming response', async () => {
      const body = createMockSSEStream([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      const response = { ok: true, body } as unknown as Response;
      const contentHandler = vi.fn();
      emitter.on('content', contentHandler);

      const result = await provider.parseResponse(response, true, emitter);
      expect(result.content).toBe('Hello World');
      expect(contentHandler).toHaveBeenCalledWith('Hello');
      expect(contentHandler).toHaveBeenCalledWith(' World');
    });

    it('parses streaming tool calls accumulated across chunks', async () => {
      const body = createMockSSEStream([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"greet"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"name\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"World\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      const response = { ok: true, body } as unknown as Response;
      const result = await provider.parseResponse(response, true, emitter);
      expect(result.toolCalls[0]).toEqual({ id: 'call_1', name: 'greet', arguments: '{"name":"World"}' });
    });

    it('emits thinking events for streaming', async () => {
      const body = createMockSSEStream([
        'data: {"choices":[{"delta":{"reasoning_content":"Let me think..."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
      const response = { ok: true, body } as unknown as Response;
      const thinkingHandler = vi.fn();
      emitter.on('thinking', thinkingHandler);

      await provider.parseResponse(response, true, emitter);
      expect(thinkingHandler).toHaveBeenCalledWith('Let me think...');
    });
  });
});
