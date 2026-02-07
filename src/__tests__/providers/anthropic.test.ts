import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../providers/anthropic.js';
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

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider();
  let emitter: TooledPromptEmitter;

  beforeEach(() => {
    emitter = new TooledPromptEmitter();
  });

  describe('buildRequest', () => {
    it('builds correct URL', () => {
      const { url } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test', modelName: 'claude-3-opus',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(url).toBe('https://api.anthropic.com/v1/messages');
    });

    it('uses x-api-key header', () => {
      const { headers } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-test', modelName: 'claude-3-opus',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Authorization']).toBeUndefined();
    });

    it('defaults max_tokens to 4096', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: undefined, modelName: 'claude-3-opus',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect(body.max_tokens).toBe(4096);
    });

    it('uses provided maxTokens', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: undefined, modelName: 'claude-3-opus',
        messages: [], tools: [], stream: false, temperature: undefined, maxTokens: 8192,
      });
      expect(body.max_tokens).toBe(8192);
    });

    it('formats tools in Anthropic format (no type wrapper)', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: undefined, modelName: 'claude-3-opus',
        messages: [], tools: [sampleTool], stream: false, temperature: undefined, maxTokens: undefined,
      });
      expect((body.tools as any[])[0]).toEqual({
        name: 'greet',
        description: 'Greet a person',
        input_schema: sampleTool.parameters,
      });
    });

    it('places system prompt in system field', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: undefined, modelName: 'claude-3-opus',
        messages: [{ role: 'user', content: 'Hello' }], tools: [], stream: false,
        temperature: undefined, maxTokens: undefined, systemPrompt: 'You are helpful.',
      });
      expect(body.system).toBe('You are helpful.');
      const messages = body.messages as any[];
      expect(messages.every((m: any) => m.role !== 'system')).toBe(true);
    });

    it('includes stream flag', () => {
      const { body } = provider.buildRequest({
        apiUrl: 'https://api.anthropic.com/v1', apiKey: undefined, modelName: 'claude-3-opus',
        messages: [], tools: [], stream: true, temperature: undefined, maxTokens: undefined,
      });
      expect(body.stream).toBe(true);
    });
  });

  describe('formatUserMessage', () => {
    it('formats plain string', () => {
      expect(provider.formatUserMessage('Hello')).toEqual({ role: 'user', content: 'Hello' });
    });

    it('converts image_url to Anthropic image format', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Describe this:' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ABC123' } },
      ];
      const result = provider.formatUserMessage(parts) as any;
      expect(result.role).toBe('user');
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Describe this:' });
      expect(result.content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'ABC123' },
      });
    });

    it('prepends system images converted to Anthropic format', () => {
      const images: ContentPart[] = [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,SYS_IMG' } },
      ];
      const result = provider.formatUserMessage('Hello', images) as any;
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'SYS_IMG' },
      });
      expect(result.content[1]).toEqual({ type: 'text', text: 'Hello' });
    });
  });

  describe('formatAssistantMessage', () => {
    it('formats content as text block', () => {
      const result = provider.formatAssistantMessage('Hello', []) as any;
      expect(result).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      });
    });

    it('formats tool calls as tool_use blocks', () => {
      const result = provider.formatAssistantMessage('', [{
        id: 'toolu_1', name: 'greet', arguments: '{"name":"World"}',
      }]) as any;
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'tool_use', id: 'toolu_1', name: 'greet', input: { name: 'World' },
      });
    });
  });

  describe('formatToolResults', () => {
    it('batches all results in single user message', () => {
      const results = provider.formatToolResults([
        { id: 'toolu_1', name: 'greet', result: 'Hello!' },
        { id: 'toolu_2', name: 'farewell', result: 'Goodbye!' },
      ]);
      expect(results).toHaveLength(1);
      const msg = results[0] as any;
      expect(msg.role).toBe('user');
      expect(msg.content).toHaveLength(2);
      expect(msg.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Hello!' });
      expect(msg.content[1]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_2', content: 'Goodbye!' });
    });
  });

  describe('parseResponse', () => {
    it('parses non-streaming response with text', async () => {
      const response = {
        json: async () => ({ content: [{ type: 'text', text: 'Hello World' }] }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.content).toBe('Hello World');
      expect(result.toolCalls).toEqual([]);
    });

    it('parses non-streaming response with tool_use', async () => {
      const response = {
        json: async () => ({
          content: [
            { type: 'text', text: 'Let me greet.' },
            { type: 'tool_use', id: 'toolu_1', name: 'greet', input: { name: 'World' } },
          ],
        }),
        body: null,
      } as unknown as Response;

      const result = await provider.parseResponse(response, false, emitter);
      expect(result.content).toBe('Let me greet.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]).toEqual({
        id: 'toolu_1', name: 'greet', arguments: '{"name":"World"}',
      });
    });

    it('parses streaming response', async () => {
      const body = createMockSSEStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" World"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      const response = { ok: true, body } as unknown as Response;
      const contentHandler = vi.fn();
      emitter.on('content', contentHandler);

      const result = await provider.parseResponse(response, true, emitter);
      expect(result.content).toBe('Hello World');
      expect(contentHandler).toHaveBeenCalledWith('Hello');
      expect(contentHandler).toHaveBeenCalledWith(' World');
    });

    it('parses streaming tool call', async () => {
      const body = createMockSSEStream([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"greet","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"name\\":\\""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"World\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop"}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]);
      const response = { ok: true, body } as unknown as Response;
      const result = await provider.parseResponse(response, true, emitter);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe('toolu_1');
      expect(result.toolCalls[0].name).toBe('greet');
      expect(result.toolCalls[0].arguments).toBe('{"name":"World"}');
    });

    it('throws when no content', async () => {
      const response = { json: async () => ({}), body: null } as unknown as Response;
      await expect(provider.parseResponse(response, false, emitter)).rejects.toThrow('No response from LLM');
    });
  });
});
