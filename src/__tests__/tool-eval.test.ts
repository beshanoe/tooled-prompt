import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolEval } from '../tool-eval.js';
import { tool } from '../tool.js';
import { TOOL_SYMBOL } from '../types.js';
import { runToolLoop } from '../executor.js';
import { TooledPromptEmitter } from '../events.js';
import type { ResolvedTooledPromptConfig } from '../types.js';

describe('toolEval', () => {
  function add(a: string, b: string) {
    return String(Number(a) + Number(b));
  }

  function multiply(a: string, b: string) {
    return String(Number(a) * Number(b));
  }

  function readFile(path: string) {
    return `contents of ${path}`;
  }

  it('creates a tool named tool_eval with correct schema', () => {
    const exec = toolEval(add, multiply);
    expect(TOOL_SYMBOL in exec).toBe(true);
    const meta = exec[TOOL_SYMBOL];
    expect(meta.name).toBe('tool_eval');
    expect(meta.parameters.properties).toHaveProperty('code');
  });

  it('description includes JSDoc-style tool signatures', () => {
    const exec = toolEval(add, multiply, readFile);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('async function add(a, b)');
    expect(desc).toContain('async function multiply(a, b)');
    expect(desc).toContain('async function readFile(path)');
  });

  it('description includes tool descriptions from metadata', () => {
    function myReadFile(path: string) {
      return `contents of ${path}`;
    }
    const wrapped = tool(myReadFile, { description: 'Read a file from disk' });
    const exec = toolEval(wrapped);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('* Read a file from disk');
    expect(desc).toContain('@param');
  });

  it('accepts already-wrapped tool functions', () => {
    function myAdd(a: string, b: string) {
      return String(Number(a) + Number(b));
    }
    const wrapped = tool(myAdd, {
      description: 'Add two numbers',
      args: [
        ['a', 'First number'],
        ['b', 'Second number'],
      ],
    });
    const exec = toolEval(wrapped);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('Add two numbers');
  });

  it('trailing options not treated as a tool', () => {
    const exec = toolEval(add, { timeout: 5000 });
    const desc = exec[TOOL_SYMBOL].description;
    // Should only have add, not an object
    expect(desc).toContain('async function add');
    expect(desc).not.toContain('timeout');
  });

  it('executes simple code returning a string', async () => {
    const exec = toolEval(add);
    const result = await exec('return "hello"');
    expect(result).toBe('hello');
  });

  it('executes code that calls a tool', async () => {
    const exec = toolEval(add);
    const result = await exec('return add("2", "3")');
    expect(result).toBe('5');
  });

  it('executes code that calls multiple tools', async () => {
    const exec = toolEval(add, multiply);
    const result = await exec(`
      const sum = add("2", "3");
      const product = multiply(sum, "4");
      return product;
    `);
    expect(result).toBe('20');
  });

  it('executes code with async tools', async () => {
    async function asyncAdd(a: string, b: string) {
      return String(Number(a) + Number(b));
    }
    const exec = toolEval(asyncAdd);
    const result = await exec('return await asyncAdd("10", "20")');
    expect(result).toBe('30');
  });

  it('returns "OK" for undefined return', async () => {
    const exec = toolEval(add);
    const result = await exec('const x = 1;');
    expect(result).toBe('OK');
  });

  it('returns "OK" for null return', async () => {
    const exec = toolEval(add);
    const result = await exec('return null;');
    expect(result).toBe('OK');
  });

  it('JSON-stringifies object return', async () => {
    const exec = toolEval(add);
    const result = await exec('return { x: 1, y: "two" }');
    expect(result).toBe(JSON.stringify({ x: 1, y: 'two' }));
  });

  it('returns error message on code error', async () => {
    const exec = toolEval(add);
    const result = await exec('throw new Error("boom")');
    expect(result).toBe('Error: boom');
  });

  it('returns error message on syntax error', async () => {
    const exec = toolEval(add);
    const result = await exec('const x = {{{');
    expect(result).toContain('Error:');
  });

  it('times out when code hangs', async () => {
    const exec = toolEval(add, { timeout: 50 });
    const result = await exec('await new Promise(r => setTimeout(r, 5000)); return "late"');
    expect(result).toContain('Timed out');
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

    it('LLM calls tool_eval and gets result', async () => {
      function addFn(a: string, b: string) {
        return String(Number(a) + Number(b));
      }
      function multiplyFn(a: string, b: string) {
        return String(Number(a) * Number(b));
      }

      const exec = toolEval(addFn, multiplyFn);

      const code = `
        const sum = addFn("2", "3");
        const product = multiplyFn(sum, "10");
        return product;
      `;

      // 1st call: LLM calls tool_eval with code
      mockFetch.mockResolvedValueOnce(
        mockLLMResponse('', [
          {
            id: 'call_1',
            function: { name: 'tool_eval', arguments: JSON.stringify({ code }) },
          },
        ]),
      );
      // 2nd call: LLM returns final answer using the result
      mockFetch.mockResolvedValueOnce(mockLLMResponse('The answer is 50'));

      const { result } = await runToolLoop('What is (2+3)*10?', [exec], config, emitter);
      expect(result).toBe('The answer is 50');

      // Only tool_eval should be in the tools array (no dynamic expansion)
      const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const toolNames = firstBody.tools.map((t: any) => t.function.name);
      expect(toolNames).toEqual(['tool_eval']);
    });
  });
});
