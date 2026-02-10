import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildPromptText, runToolLoop } from '../executor.js';
import { tool } from '../tool.js';
import type { ResolvedTooledPromptConfig } from '../types.js';
import { resolveSchema } from '../types.js';
import { TooledPromptEmitter } from '../events.js';
import { z } from 'zod';

describe('buildPromptText', () => {
  it('joins template strings with no values', () => {
    const strings = Object.assign(['Hello world'], { raw: ['Hello world'] }) as TemplateStringsArray;
    const result = buildPromptText(strings, []);
    expect(result).toBe('Hello world');
  });

  it('interpolates string values', () => {
    const strings = Object.assign(['Hello ', '!'], { raw: ['Hello ', '!'] }) as TemplateStringsArray;
    const result = buildPromptText(strings, ['world']);
    expect(result).toBe('Hello world!');
  });

  it('interpolates numbers and other primitives', () => {
    const strings = Object.assign(['Count: ', ' and ', ''], {
      raw: ['Count: ', ' and ', ''],
    }) as TemplateStringsArray;
    const result = buildPromptText(strings, [42, true]);
    expect(result).toBe('Count: 42 and true');
  });

  it('replaces tool references with natural language', () => {
    function myTool(x: string) {
      return x;
    }
    const wrapped = tool(myTool, { description: 'A test tool' });

    const strings = Object.assign(['Use ', ' to process data'], {
      raw: ['Use ', ' to process data'],
    }) as TemplateStringsArray;
    const result = buildPromptText(strings, [wrapped]);
    expect(result).toBe('Use the "myTool" tool to process data');
  });

  it('handles multiple tools', () => {
    const toolA = tool(function readFile(path: string) {
      return path;
    });
    const toolB = tool(function writeFile(path: string, _content: string) {
      return path;
    });

    const strings = Object.assign(['Use ', ' and ', ' for file operations'], {
      raw: ['Use ', ' and ', ' for file operations'],
    }) as TemplateStringsArray;
    const result = buildPromptText(strings, [toolA, toolB]);
    expect(result).toBe('Use the "readFile" tool and the "writeFile" tool for file operations');
  });

  it('skips undefined and null values', () => {
    const strings = Object.assign(['A', 'B', 'C'], {
      raw: ['A', 'B', 'C'],
    }) as TemplateStringsArray;
    const result = buildPromptText(strings, [undefined, null]);
    expect(result).toBe('ABC');
  });

  it('trims trailing whitespace from lines', () => {
    const strings = Object.assign(['line1   \nline2   \n   '], {
      raw: ['line1   \nline2   \n   '],
    }) as TemplateStringsArray;
    const result = buildPromptText(strings, []);
    expect(result).toBe('line1\nline2');
  });
});

describe('runToolLoop', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;
  let emitter: TooledPromptEmitter;
  let defaultConfig: ResolvedTooledPromptConfig;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    emitter = new TooledPromptEmitter();
    defaultConfig = {
      apiUrl: 'http://localhost:8080/v1',
      modelName: 'test-model',
      apiKey: 'test-key',
      maxIterations: undefined,
      temperature: undefined,
      stream: true,
      timeout: 60000,
      silent: true,
      showThinking: false,
      provider: 'openai',
      maxTokens: undefined,
      systemPrompt: undefined,
      maxToolResultLength: undefined,
    };
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
    }>,
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

  it('returns LLM response when no tool calls', async () => {
    mockFetch.mockResolvedValue(mockLLMResponse('Hello, world!'));

    const { result } = await runToolLoop('Say hello', [], defaultConfig, emitter);

    expect(result).toBe('Hello, world!');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('sends correct request body', async () => {
    mockFetch.mockResolvedValue(mockLLMResponse('OK'));

    await runToolLoop('Test prompt', [], defaultConfig, emitter);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-key',
        },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'Test prompt' }]);
  });

  it('includes tools in request when provided', async () => {
    const myTool = tool(function greet(name: string) {
      return `Hello, ${name}!`;
    });

    mockFetch.mockResolvedValue(mockLLMResponse('Done'));

    await runToolLoop('Use greet', [myTool], defaultConfig, emitter);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe('greet');
    expect(body.tool_choice).toBe('auto');
  });

  it('executes single tool call and returns result', async () => {
    const greet = vi.fn((name: string) => `Hello, ${name}!`);
    // Use tuple args to provide explicit param names matching JSON keys from LLM
    const greetTool = tool({ greet }, { args: [['name', 'The name to greet']] });

    // First call: LLM requests tool
    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'greet', arguments: '{"name":"World"}' } }]),
    );
    // Second call: LLM returns final response
    mockFetch.mockResolvedValueOnce(mockLLMResponse('I greeted World!'));

    const { result } = await runToolLoop('Greet World', [greetTool], defaultConfig, emitter);

    expect(greet).toHaveBeenCalledWith('World');
    expect(result).toBe('I greeted World!');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles multiple tool calls in sequence', async () => {
    const add = vi.fn((a: number, b: number) => a + b);
    // Use tuple args so param names match JSON keys: a, b
    const addTool = tool(
      { add },
      {
        args: [
          ['a', 'First number'],
          ['b', 'Second number'],
        ],
      },
    );

    // First call: LLM requests first tool
    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'add', arguments: '{"a":1,"b":2}' } }]),
    );
    // Second call: LLM requests another tool
    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call2', function: { name: 'add', arguments: '{"a":3,"b":4}' } }]),
    );
    // Third call: LLM returns final response
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Results: 3 and 7'));

    const { result } = await runToolLoop('Add 1+2 then 3+4', [addTool], defaultConfig, emitter);

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenNthCalledWith(1, 1, 2);
    expect(add).toHaveBeenNthCalledWith(2, 3, 4);
    expect(result).toBe('Results: 3 and 7');
  });

  it('respects maxIterations', async () => {
    const configWithLowIterations = { ...defaultConfig, maxIterations: 2 };
    const infiniteTool = tool(function loop() {
      return 'continue';
    });

    // Always request tool call
    mockFetch.mockResolvedValue(mockLLMResponse('', [{ id: 'call1', function: { name: 'loop', arguments: '{}' } }]));

    await expect(runToolLoop('Loop forever', [infiniteTool], configWithLowIterations, emitter)).rejects.toThrow(
      'Max iterations (2) reached',
    );
  });

  it('validates response against schema', async () => {
    const schema = resolveSchema(
      z.object({
        name: z.string(),
        age: z.number(),
      }),
    );

    mockFetch.mockResolvedValue(mockLLMResponse('{"name":"John","age":30}'));

    const { result } = await runToolLoop('Get user', [], defaultConfig, emitter, schema);

    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('throws on schema validation failure', async () => {
    const schema = resolveSchema(
      z.object({
        name: z.string(),
        age: z.number(),
      }),
    );

    mockFetch.mockResolvedValue(mockLLMResponse('{"name":"John","age":"thirty"}'));

    await expect(runToolLoop('Get user', [], defaultConfig, emitter, schema)).rejects.toThrow(
      'Schema validation failed',
    );
  });

  it('throws on invalid JSON response when schema expected', async () => {
    const schema = resolveSchema(z.object({ name: z.string() }));

    mockFetch.mockResolvedValue(mockLLMResponse('not json'));

    await expect(runToolLoop('Get user', [], defaultConfig, emitter, schema)).rejects.toThrow('Failed to parse JSON');
  });

  it('handles tool execution errors', async () => {
    const failingTool = tool(function fail() {
      throw new Error('Tool error!');
    });

    // First call: LLM requests tool
    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'fail', arguments: '{}' } }]),
    );
    // Second call: LLM returns response after receiving error
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Tool failed'));

    const errorHandler = vi.fn();
    emitter.on('tool_error', errorHandler);

    const { result } = await runToolLoop('Try to fail', [failingTool], defaultConfig, emitter);

    expect(errorHandler).toHaveBeenCalledWith('fail', 'Tool error!');
    expect(result).toBe('Tool failed');
  });

  it('handles LLM API errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(runToolLoop('Test', [], defaultConfig, emitter)).rejects.toThrow(
      'LLM request failed (500): Internal Server Error',
    );
  });

  it('handles timeout', async () => {
    const slowConfig = { ...defaultConfig, timeout: 10 };

    // Mock a fetch that respects the abort signal
    mockFetch.mockImplementation(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            resolve(mockLLMResponse('This should not be reached'));
          }, 1000);

          // Handle abort signal
          options?.signal?.addEventListener('abort', () => {
            clearTimeout(timeoutId);
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    await expect(runToolLoop('Test', [], slowConfig, emitter)).rejects.toThrow('Request timeout after 10ms');
  });

  it('handles unknown tool gracefully', async () => {
    // LLM requests a tool that doesn't exist
    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'unknownTool', arguments: '{}' } }]),
    );
    // LLM responds after receiving error
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Unknown tool error'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = await runToolLoop('Use unknown', [], defaultConfig, emitter);

    expect(warnSpy).toHaveBeenCalledWith('Unknown tool: unknownTool');
    expect(result).toBe('Unknown tool error');

    warnSpy.mockRestore();
  });

  it('handles invalid JSON in tool arguments', async () => {
    const myTool = tool(function test(x: string) {
      return x;
    });

    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'test', arguments: 'not json' } }]),
    );
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Recovered'));

    const errorHandler = vi.fn();
    emitter.on('tool_error', errorHandler);

    const { result } = await runToolLoop('Test', [myTool], defaultConfig, emitter);

    expect(errorHandler).toHaveBeenCalledWith('test', expect.stringContaining('Invalid JSON'));
    expect(result).toBe('Recovered');
  });

  it('emits events during execution', async () => {
    const myTool = tool(function echo(msg: string) {
      return msg;
    });

    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'echo', arguments: '{"msg":"hello"}' } }]),
    );
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

    const toolCallHandler = vi.fn();
    const toolResultHandler = vi.fn();
    emitter.on('tool_call', toolCallHandler);
    emitter.on('tool_result', toolResultHandler);

    await runToolLoop('Echo hello', [myTool], defaultConfig, emitter);

    expect(toolCallHandler).toHaveBeenCalledWith('echo', { msg: 'hello' });
    expect(toolResultHandler).toHaveBeenCalledWith('echo', 'hello', expect.any(Number));
  });

  it('emits content events for non-streaming responses', async () => {
    mockFetch.mockResolvedValue(mockLLMResponse('Test content'));

    const contentHandler = vi.fn();
    emitter.on('content', contentHandler);

    await runToolLoop('Test', [], defaultConfig, emitter);

    expect(contentHandler).toHaveBeenCalledWith('Test content\n');
  });

  it('handles tool returning void/undefined', async () => {
    const voidTool = tool(function doNothing() {
      // Returns undefined
    });

    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'doNothing', arguments: '{}' } }]),
    );
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

    const { result } = await runToolLoop('Do nothing', [voidTool], defaultConfig, emitter);

    // Verify second call includes "OK" as result
    const secondCall = mockFetch.mock.calls[1];
    const body = JSON.parse(secondCall[1].body);
    const toolMessage = body.messages.find((m: any) => m.role === 'tool');
    expect(toolMessage.content).toBe('OK');
    expect(result).toBe('Done');
  });

  it('handles tool returning object', async () => {
    const objectTool = tool(function getUser() {
      return { name: 'John', age: 30 };
    });

    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [{ id: 'call1', function: { name: 'getUser', arguments: '{}' } }]),
    );
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Got user'));

    await runToolLoop('Get user', [objectTool], defaultConfig, emitter);

    const secondCall = mockFetch.mock.calls[1];
    const body = JSON.parse(secondCall[1].body);
    const toolMessage = body.messages.find((m: any) => m.role === 'tool');
    expect(toolMessage.content).toBe('{"name":"John","age":30}');
  });

  it('passes arguments in correct parameter order', async () => {
    const ordered = vi.fn((first: string, second: string, third: string) => {
      return `${first}-${second}-${third}`;
    });
    // Use tuple args so param names match JSON keys
    const orderedTool = tool(
      { ordered },
      {
        args: [
          ['first', 'First'],
          ['second', 'Second'],
          ['third', 'Third'],
        ],
      },
    );

    mockFetch.mockResolvedValueOnce(
      mockLLMResponse('', [
        {
          id: 'call1',
          function: { name: 'ordered', arguments: '{"first":"A","second":"B","third":"C"}' },
        },
      ]),
    );
    mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

    await runToolLoop('Test order', [orderedTool], defaultConfig, emitter);

    expect(ordered).toHaveBeenCalledWith('A', 'B', 'C');
  });

  describe('iterable tool results', () => {
    it('collects async iterable to array and JSON-stringifies', async () => {
      async function* asyncGen() {
        yield { name: 'file1.txt' };
        yield { name: 'file2.txt' };
      }
      const iterTool = tool(function readDir() {
        return asyncGen();
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [{ id: 'call1', function: { name: 'readDir', arguments: '{}' } }]),
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Found files'));

      await runToolLoop('List dir', [iterTool], defaultConfig, emitter);

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolMessage = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toBe(JSON.stringify([{ name: 'file1.txt' }, { name: 'file2.txt' }]));
    });

    it('collects sync iterable to array and JSON-stringifies', async () => {
      function* syncGen() {
        yield 1;
        yield 2;
        yield 3;
      }
      const iterTool = tool(function generate() {
        return syncGen();
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [{ id: 'call1', function: { name: 'generate', arguments: '{}' } }]),
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Got numbers'));

      await runToolLoop('Generate', [iterTool], defaultConfig, emitter);

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolMessage = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toBe(JSON.stringify([1, 2, 3]));
    });

    it('does NOT iterate strings (passes through as-is)', async () => {
      const strTool = tool(function getText() {
        return 'hello';
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [{ id: 'call1', function: { name: 'getText', arguments: '{}' } }]),
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

      await runToolLoop('Get text', [strTool], defaultConfig, emitter);

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolMessage = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toBe('hello');
    });

    it('passes arrays through unchanged', async () => {
      const arrTool = tool(function getList() {
        return [1, 2, 3];
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [{ id: 'call1', function: { name: 'getList', arguments: '{}' } }]),
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

      await runToolLoop('Get list', [arrTool], defaultConfig, emitter);

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolMessage = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toBe(JSON.stringify([1, 2, 3]));
    });

    it('passes plain objects through unchanged', async () => {
      const objTool = tool(function getObj() {
        return { key: 'value' };
      });

      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [{ id: 'call1', function: { name: 'getObj', arguments: '{}' } }]),
      );
      mockFetch.mockResolvedValueOnce(mockLLMResponse('Done'));

      await runToolLoop('Get obj', [objTool], defaultConfig, emitter);

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolMessage = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMessage.content).toBe(JSON.stringify({ key: 'value' }));
    });
  });

  it('returns messages including final assistant message', async () => {
    mockFetch.mockResolvedValue(mockLLMResponse('Hello!'));

    const { messages } = await runToolLoop('Hi', [], defaultConfig, emitter);

    // messages: [user, assistant]
    expect(messages).toHaveLength(2);
    expect((messages[0] as any).role).toBe('user');
    expect((messages[1] as any).role).toBe('assistant');
    expect((messages[1] as any).content).toBe('Hello!');
  });

  it('prepends history when provided', async () => {
    mockFetch.mockResolvedValue(mockLLMResponse('Follow up response'));

    const history = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: 'First response' },
    ];

    const { result, messages } = await runToolLoop(
      'Follow up',
      [],
      defaultConfig,
      emitter,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    );

    expect(result).toBe('Follow up response');

    // Verify API received history + new user message
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'First message' });
    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'First response' });
    expect(body.messages[2].role).toBe('user');

    // Returned messages include everything + final assistant
    expect(messages).toHaveLength(4);
  });

  describe('streaming responses', () => {
    function createMockStream(chunks: string[]) {
      const encoder = new TextEncoder();
      let index = 0;

      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () => {
              if (index < chunks.length) {
                return { done: false, value: encoder.encode(chunks[index++]) };
              }
              return { done: true, value: undefined };
            },
          }),
        },
      };
    }

    it('handles streaming content', async () => {
      const streamConfig = { ...defaultConfig, stream: true };

      mockFetch.mockResolvedValue(
        createMockStream([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" World"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

      const contentHandler = vi.fn();
      emitter.on('content', contentHandler);

      const { result } = await runToolLoop('Test', [], streamConfig, emitter);

      expect(result).toBe('Hello World');
      expect(contentHandler).toHaveBeenCalledWith('Hello');
      expect(contentHandler).toHaveBeenCalledWith(' World');
    });

    it('handles streaming tool calls', async () => {
      const streamConfig = { ...defaultConfig, stream: true };
      const echo = vi.fn((x: string) => x);
      // Use tuple args so param name matches JSON key
      const echoTool = tool({ echo }, { args: [['x', 'Value to echo']] });

      // First request: streaming tool call
      mockFetch.mockResolvedValueOnce(
        createMockStream([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"echo"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"hi\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      );

      // Second request: final response (non-streaming for simplicity)
      mockFetch.mockResolvedValueOnce(
        createMockStream(['data: {"choices":[{"delta":{"content":"Done"}}]}\n\n', 'data: [DONE]\n\n']),
      );

      const { result } = await runToolLoop('Echo hi', [echoTool], streamConfig, emitter);

      expect(echo).toHaveBeenCalledWith('hi');
      expect(result).toBe('Done');
    });
  });
});
