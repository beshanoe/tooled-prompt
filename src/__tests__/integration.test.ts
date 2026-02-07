import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTooledPrompt } from '../factory.js';
import { tool, getToolMetadata } from '../tool.js';

/**
 * Integration tests
 *
 * These tests verify end-to-end behavior, ensuring that components
 * work together correctly.
 */

describe('integration', () => {
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

  function mockLLMResponse(
    content: string,
    toolCalls?: Array<{
      id: string;
      function: { name: string; arguments: string };
    }>
  ) {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content,
              tool_calls: toolCalls?.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: tc.function,
              })),
            },
          },
        ],
      }),
    };
  }

  describe('tool() wraps function and keeps it callable', () => {
    it('wrapped sync function can be called directly', () => {
      function add(a: number, b: number) {
        return a + b;
      }
      const wrapped = tool(add);

      // Function should still work
      expect(wrapped(2, 3)).toBe(5);
      expect(wrapped(10, -5)).toBe(5);
    });

    it('wrapped async function can be called directly', async () => {
      async function fetchData(url: string) {
        return `fetched: ${url}`;
      }
      const wrapped = tool(fetchData);

      const result = await wrapped('https://example.com');
      expect(result).toBe('fetched: https://example.com');
    });

    it('wrapped function preserves this binding', () => {
      const obj = {
        multiplier: 10,
        multiply(x: number) {
          return x * this.multiplier;
        },
      };

      const wrapped = tool(obj.multiply.bind(obj));
      expect(wrapped(5)).toBe(50);
    });

    it('wrapped function can throw errors', () => {
      function failing() {
        throw new Error('Expected error');
      }
      const wrapped = tool(failing);

      expect(() => wrapped()).toThrow('Expected error');
    });
  });

  describe('tool arguments are passed in correct order', () => {
    it('preserves argument order based on parameter names', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const calls: Array<{ first: string; second: string; third: string }> = [];
      function ordered(first: string, second: string, third: string) {
        calls.push({ first, second, third });
        return 'done';
      }
      const orderedTool = tool(ordered, {
        args: ['First param', 'Second param', 'Third param'],
      });

      // LLM requests tool with args in different JSON key order
      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          {
            id: 'call1',
            function: {
              name: 'ordered',
              // JSON keys in different order than function params
              arguments: '{"third":"C","first":"A","second":"B"}',
            },
          },
        ])
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Complete'));

      await prompt`Use ${orderedTool} with A, B, C`();

      expect(calls).toHaveLength(1);
      // Arguments should be mapped by name, not JSON order
      expect(calls[0]).toEqual({ first: 'A', second: 'B', third: 'C' });
    });

    it('handles missing optional arguments', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const calls: Array<{ required: string; optional: string | undefined }> = [];
      function withOptional(required: string, optional: string = 'default') {
        calls.push({ required, optional });
        return 'done';
      }
      const optionalTool = tool(withOptional, {
        args: ['Required param', 'Optional param'],
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          {
            id: 'call1',
            function: {
              name: 'withOptional',
              arguments: '{"required":"value"}', // optional not provided
            },
          },
        ])
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

      await prompt`Use ${optionalTool}`();

      expect(calls).toHaveLength(1);
      expect(calls[0].required).toBe('value');
      // undefined is passed when not in JSON, default value applies in function
    });
  });

  describe('event handlers receive events during execution', () => {
    it('content handler receives LLM output', async () => {
      const { prompt, on } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const contentChunks: string[] = [];
      on('content', (content) => contentChunks.push(content));

      mockFetch.mockResolvedValue(mockLLMResponse('Hello from LLM'));

      await prompt`Say hello`();

      expect(contentChunks).toContain('Hello from LLM\n');
    });

    it('tool_call and tool_result handlers fire during tool execution', async () => {
      const { prompt, on } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const toolCalls: Array<{ name: string; args: unknown }> = [];
      const toolResults: Array<{ name: string; result: unknown; duration: number }> = [];

      on('tool_call', (name, args) => toolCalls.push({ name, args }));
      on('tool_result', (name, result, duration) =>
        toolResults.push({ name, result, duration })
      );

      function echo(message: string) {
        return message.toUpperCase();
      }
      const echoTool = tool(echo, { args: ['Message to echo'] });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          { id: 'call1', function: { name: 'echo', arguments: '{"message":"hello"}' } },
        ])
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

      await prompt`Use ${echoTool}`();

      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toEqual({ name: 'echo', args: { message: 'hello' } });

      expect(toolResults).toHaveLength(1);
      expect(toolResults[0].name).toBe('echo');
      expect(toolResults[0].result).toBe('HELLO');
      expect(toolResults[0].duration).toBeGreaterThanOrEqual(0);
    });

    it('tool_error handler fires on tool failure', async () => {
      const { prompt, on } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const errors: Array<{ name: string; error: string }> = [];
      on('tool_error', (name, error) => errors.push({ name, error }));

      function failing() {
        throw new Error('Tool exploded');
      }
      const failingTool = tool(failing);

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          { id: 'call1', function: { name: 'failing', arguments: '{}' } },
        ])
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Handled error'));

      await prompt`Use ${failingTool}`();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual({ name: 'failing', error: 'Tool exploded' });
    });

    it('off() removes event handlers', async () => {
      const { prompt, on, off } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      const contentChunks: string[] = [];
      const handler = (content: string) => contentChunks.push(content);

      on('content', handler);
      off('content', handler);

      mockFetch.mockResolvedValue(mockLLMResponse('Hello'));

      await prompt`Say hello`();

      expect(contentChunks).toHaveLength(0);
    });
  });

  describe('config is applied correctly', () => {
    it('factory config is used in API request', async () => {
      const { prompt } = createTooledPrompt({
        apiUrl: 'https://custom-api.example.com/v1',
        modelName: 'custom-model',
        apiKey: 'custom-key',
        temperature: 0.7,
        silent: true,
      });

      mockFetch.mockResolvedValue(mockLLMResponse('OK'));

      await prompt`Test`();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://custom-api.example.com/v1/chat/completions',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer custom-key',
          }),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('custom-model');
      expect(body.temperature).toBe(0.7);
    });

    it('setConfig updates instance config', async () => {
      const { prompt, setConfig } = createTooledPrompt({
        apiKey: 'initial',
        silent: true,
      });

      setConfig({ modelName: 'updated-model', temperature: 0.9 });

      mockFetch.mockResolvedValue(mockLLMResponse('OK'));

      await prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('updated-model');
      expect(body.temperature).toBe(0.9);
    });

    it('per-call config overrides instance config', async () => {
      const { prompt, setConfig } = createTooledPrompt({
        modelName: 'instance-model', temperature: 0.5, silent: true,
      });

      setConfig({ temperature: 0.7 });

      mockFetch.mockResolvedValue(mockLLMResponse('OK'));

      await prompt`Test`({ temperature: 0.9, modelName: 'call-model' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('call-model');
      expect(body.temperature).toBe(0.9);
    });
  });

  describe('prompt template with tools', () => {
    it('includes tools in request when embedded in template', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      // Use a unique function definition to avoid any naming collision
      function fetchFileContents(path: string) {
        return 'file contents';
      }
      const fileTool = tool(fetchFileContents, { args: ['File path'] });

      mockFetch.mockResolvedValue(mockLLMResponse('Read complete'));

      await prompt`Use ${fileTool} to read config.json`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe('fetchFileContents');
      expect(body.messages[0].content).toContain('the "fetchFileContents" tool');
    });

    it('auto-wraps plain functions as tools', async () => {
      const { prompt } = createTooledPrompt({
        apiKey: 'test', silent: true,
      });

      // Suppress console.warn for auto-wrapped function
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      function multiply(a: number, b: number) {
        return a * b;
      }

      mockFetch.mockResolvedValue(mockLLMResponse('Multiplied'));

      await prompt`Use ${multiply} to multiply numbers`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe('multiply');

      warnSpy.mockRestore();
    });
  });
});
