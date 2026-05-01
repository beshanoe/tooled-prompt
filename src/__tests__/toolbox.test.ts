import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolSearch, TOOLBOX_SYMBOL } from '../toolbox.js';
import { tool } from '../tool.js';
import { TOOL_SYMBOL } from '../types.js';
import { runToolLoop } from '../executor.js';
import { TooledPromptEmitter } from '../events.js';
import type { ResolvedTooledPromptConfig } from '../types.js';

describe('toolSearch', () => {
  function readFile(path: string) {
    return `contents of ${path}`;
  }
  function writeFile(_path: string, _content: string) {
    return 'ok';
  }
  function sendEmail(to: string, _body: string) {
    return `sent to ${to}`;
  }

  it('creates a tool named tool_search with correct schema', () => {
    const search = toolSearch(readFile, writeFile);
    expect(TOOL_SYMBOL in search).toBe(true);
    const meta = search[TOOL_SYMBOL];
    expect(meta.name).toBe('tool_search');
    expect(meta.parameters.properties).toHaveProperty('query');
  });

  it('has TOOLBOX_SYMBOL with pending array', () => {
    const search = toolSearch(readFile);
    expect(TOOLBOX_SYMBOL in search).toBe(true);
    expect(search[TOOLBOX_SYMBOL].pending).toEqual([]);
  });

  it('matches tools by keyword and populates pending', async () => {
    const search = toolSearch(readFile, writeFile, sendEmail);
    // Call the function directly
    const result = await search('file');
    expect(result).toContain('read_file');
    expect(result).toContain('write_file');
    expect(search[TOOLBOX_SYMBOL].pending).toHaveLength(2);
  });

  it('returns available tool names on no match', async () => {
    const search = toolSearch(readFile, writeFile);
    const result = await search('database');
    expect(result).toContain('No tools found');
    expect(result).toContain('Try a different search term');
    expect(result).not.toContain('read_file');
    expect(search[TOOLBOX_SYMBOL].pending).toHaveLength(0);
  });

  it('deduplicates tools in pending', async () => {
    const search = toolSearch(readFile, writeFile);
    // Search twice for the same tools
    await search('file');
    await search('file');
    const names = search[TOOLBOX_SYMBOL].pending.map((t) => t[TOOL_SYMBOL].name);
    const unique = new Set(names);
    expect(names.length).toBe(unique.size);
  });

  it('accepts already-wrapped tool functions', async () => {
    function readFileFresh(path: string) {
      return `contents of ${path}`;
    }
    const wrapped = tool(readFileFresh, { description: 'Read a file from disk' });
    const search = toolSearch(wrapped);
    const result = await search('file');
    expect(result).toContain('Read a file from disk');
  });

  it('uses custom match function when provided', async () => {
    const customMatch = vi.fn((_query, tools) => [tools[0]]);
    const search = toolSearch(readFile, writeFile, { match: customMatch });
    const result = await search('anything');
    expect(customMatch).toHaveBeenCalledWith('anything', expect.any(Array));
    expect(result).toContain('read_file');
    expect(search[TOOLBOX_SYMBOL].pending).toHaveLength(1);
  });

  describe('integration with runToolLoop', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: ReturnType<typeof vi.fn>;
    let emitter: TooledPromptEmitter;
    let config: ResolvedTooledPromptConfig;

    beforeEach(() => {
      process.env.NO_COLOR = '1';
      originalFetch = globalThis.fetch;
      mockFetch = vi.fn();
      globalThis.fetch = mockFetch;
      emitter = new TooledPromptEmitter();
      config = {
        apiUrl: 'http://localhost:8080/v1',
        modelName: 'test-model',
        apiKey: 'test-key',
        maxIterations: 10,
        temperature: undefined,
        stream: false,
        timeout: 60000,
        silent: true,
        showThinking: false,
        provider: 'openai',
        maxTokens: undefined,
        systemPrompt: undefined,
        maxToolResultLength: undefined,
        streamChunkTimeoutMs: undefined,
      };
    });

    afterEach(() => {
      delete process.env.NO_COLOR;
      globalThis.fetch = originalFetch;
    });

    function mockLLMResponse(
      content: string,
      toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>,
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

    it('discovered tools appear in subsequent request', async () => {
      function addFn(a: string, b: string) {
        return String(Number(a) + Number(b));
      }
      const add = tool(addFn, {
        args: [
          ['a', 'First number'],
          ['b', 'Second number'],
        ],
      });

      const search = toolSearch(add);

      // 1st call: LLM calls tool_search
      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          {
            id: 'call_1',
            function: { name: 'tool_search', arguments: JSON.stringify({ query: 'add' }) },
          },
        ]),
      );
      // 2nd call: LLM calls add (now available)
      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          {
            id: 'call_2',
            function: { name: 'add_fn', arguments: JSON.stringify({ a: '2', b: '3' }) },
          },
        ]),
      );
      // 3rd call: LLM returns final answer
      mockFetch.mockResolvedValueOnce(mockLLMResponse('The answer is 5'));

      const { result } = await runToolLoop('Add 2 + 3', [search], config, emitter);
      expect(result).toBe('The answer is 5');

      // Verify the 2nd request includes both tool_search and add
      const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const toolNames = secondBody.tools.map((t: any) => t.function.name);
      expect(toolNames).toContain('tool_search');
      expect(toolNames).toContain('add_fn');
    });
  });
});
