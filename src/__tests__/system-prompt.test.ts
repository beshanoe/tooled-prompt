import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTooledPrompt } from '../factory.js';
import { tool } from '../tool.js';

describe('systemPrompt', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    globalThis.fetch = originalFetch;
  });

  function mockLLMResponse(content: string) {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content, tool_calls: undefined } }],
      }),
    };
  }

  describe('plain string systemPrompt', () => {
    it('sends system message for OpenAI provider', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: 'You are a helpful assistant.',
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Hello'));

      await prompt`Say hello`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const messages = body.messages;
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
      expect(messages[1]).toEqual({ role: 'user', content: 'Say hello' });
    });

    it('sends system field for Anthropic provider', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        provider: 'anthropic',
        systemPrompt: 'You are a helpful assistant.',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'Hello' }],
        }),
      });

      await prompt`Say hello`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBe('You are a helpful assistant.');
      // Messages should not contain system role
      const messages = body.messages as any[];
      expect(messages.every((m: any) => m.role !== 'system')).toBe(true);
    });

    it('sends system message for Ollama provider', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        provider: 'ollama',
        systemPrompt: 'You are a helpful assistant.',
      });

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: 'Hello', role: 'assistant' },
        }),
      });

      await prompt`Say hello`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const messages = body.messages;
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    });
  });

  describe('builder callback systemPrompt', () => {
    it('extracts tools from system prompt and merges with prompt tools', async () => {
      function searchTool(query: string) {
        return `results for ${query}`;
      }
      const wrappedSearch = tool(searchTool, { args: ['Search query'] });

      function formatTool(text: string) {
        return text.toUpperCase();
      }
      const wrappedFormat = tool(formatTool, { args: ['Text to format'] });

      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: prompt => prompt`You are an assistant. Use ${wrappedSearch} to find info.`,
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Use ${wrappedFormat} to format text`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Should have both tools: formatTool from prompt + searchTool from systemPrompt
      expect(body.tools).toHaveLength(2);
      const toolNames = body.tools.map((t: any) => t.function.name);
      expect(toolNames).toContain('formatTool');
      expect(toolNames).toContain('searchTool');
    });

    it('replaces tool refs with natural language in system prompt text', async () => {
      function searchTool(query: string) {
        return `results for ${query}`;
      }
      const wrappedSearch = tool(searchTool, { args: ['Search query'] });

      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: prompt => prompt`Use ${wrappedSearch} to find info.`,
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Do something`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // System message should have tool ref replaced
      const systemMsg = body.messages[0];
      expect(systemMsg.role).toBe('system');
      expect(systemMsg.content).toBe('Use the "searchTool" tool to find info.');
    });

    it('plain string interpolation in system prompt works', async () => {
      const role = 'data analyst';

      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: prompt => prompt`You are a ${role}. Be precise.`,
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Analyze this data`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemMsg = body.messages[0];
      expect(systemMsg.content).toBe('You are a data analyst. Be precise.');
    });
  });

  describe('config layering', () => {
    it('per-call systemPrompt overrides instance-level systemPrompt', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: 'Instance system prompt',
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Test`({ systemPrompt: 'Call-level system prompt' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemMsg = body.messages[0];
      expect(systemMsg.content).toBe('Call-level system prompt');
    });

    it('setConfig systemPrompt overrides factory systemPrompt', async () => {
      const { prompt, setConfig } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: 'Factory system prompt',
      });

      setConfig({ systemPrompt: 'Updated system prompt' });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      const systemMsg = body.messages[0];
      expect(systemMsg.content).toBe('Updated system prompt');
    });

    it('no system message when systemPrompt is not configured', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
      });

      mockFetch.mockResolvedValue(mockLLMResponse('Done'));

      await prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // Should only have user message, no system
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user');
    });
  });

  describe('system prompt in next continuations', () => {
    it('sends system prompt on the second turn via next', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test',
        silent: true,
        systemPrompt: 'You are a helpful assistant.',
      });

      // First turn
      mockFetch.mockResolvedValueOnce(mockLLMResponse('First response'));
      const result1 = await prompt`Hello`();
      const { next } = result1;

      // Second turn via next
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Second response'));
      await next`Follow up`();

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const messages = secondBody.messages;
      // System message should be present on the second turn
      expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    });
  });

  describe('config validation', () => {
    it('validates maxTokens is positive integer', () => {
      expect(() => createTooledPrompt({ maxTokens: 0 })).toThrow('maxTokens must be a positive integer');
      expect(() => createTooledPrompt({ maxTokens: -1 })).toThrow('maxTokens must be a positive integer');
      expect(() => createTooledPrompt({ maxTokens: 1.5 })).toThrow('maxTokens must be a positive integer');
    });

    it('accepts valid maxTokens', () => {
      expect(() => createTooledPrompt({ maxTokens: 1 })).not.toThrow();
      expect(() => createTooledPrompt({ maxTokens: 4096 })).not.toThrow();
    });
  });
});

describe('provider selection', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    globalThis.fetch = originalFetch;
  });

  it('OpenAI provider sends to /chat/completions', async () => {
    const { prompt } = createTooledPrompt({
      apiUrl: 'http://localhost:8080/v1',
      apiKey: 'test',
      silent: true,
      provider: 'openai',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
    });

    await prompt`Test`();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/chat/completions',
      expect.any(Object),
    );
  });

  it('Anthropic provider sends to /messages', async () => {
    const { prompt } = createTooledPrompt({
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      silent: true,
      provider: 'anthropic',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'OK' }] }),
    });

    await prompt`Test`();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.any(Object),
    );

    // Verify Anthropic headers
    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers['x-api-key']).toBe('test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('Ollama provider sends to /api/chat', async () => {
    const { prompt } = createTooledPrompt({
      apiUrl: 'http://localhost:11434',
      silent: true,
      provider: 'ollama',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'OK', role: 'assistant' } }),
    });

    await prompt`Test`();

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.any(Object),
    );
  });

  it('Anthropic provider uses max_tokens default of 4096', async () => {
    const { prompt } = createTooledPrompt({
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      silent: true,
      provider: 'anthropic',
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'OK' }] }),
    });

    await prompt`Test`();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  it('Anthropic provider tool loop works with tool calls', async () => {
    const greet = vi.fn((name: string) => `Hello, ${name}!`);
    const greetTool = tool({ greet }, { args: [['name', 'Name to greet']] });

    const { prompt } = createTooledPrompt({
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test',
      silent: true,
      provider: 'anthropic',
    });

    // First call: Anthropic returns tool_use
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'Let me greet.' },
          { type: 'tool_use', id: 'toolu_1', name: 'greet', input: { name: 'World' } },
        ],
      }),
    });

    // Second call: Anthropic returns final text
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'I greeted World!' }],
      }),
    });

    const result = await prompt`Use ${greetTool} to greet World`();

    expect(greet).toHaveBeenCalledWith('World');
    expect(result.data).toBe('I greeted World!');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify second call has tool_result in correct Anthropic format
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const messages = secondBody.messages;
    // user, assistant (with tool_use), user (with tool_result)
    expect(messages).toHaveLength(3);

    // Tool result should be in Anthropic format
    const toolResultMsg = messages[2];
    expect(toolResultMsg.role).toBe('user');
    expect(toolResultMsg.content[0].type).toBe('tool_result');
    expect(toolResultMsg.content[0].tool_use_id).toBe('toolu_1');
    expect(toolResultMsg.content[0].content).toBe('Hello, World!');
  });

  it('Ollama provider tool loop works with tool calls', async () => {
    const greet = vi.fn((name: string) => `Hello, ${name}!`);
    const greetTool = tool({ greet }, { args: [['name', 'Name to greet']] });

    const { prompt } = createTooledPrompt({
      apiUrl: 'http://localhost:11434',
      silent: true,
      provider: 'ollama',
    });

    // First call: Ollama returns tool call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: {
          content: '',
          role: 'assistant',
          tool_calls: [{
            function: { name: 'greet', arguments: { name: 'World' } },
          }],
        },
      }),
    });

    // Second call: Ollama returns final response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        message: { content: 'I greeted World!', role: 'assistant' },
      }),
    });

    const result = await prompt`Use ${greetTool} to greet World`();

    expect(greet).toHaveBeenCalledWith('World');
    expect(result.data).toBe('I greeted World!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
