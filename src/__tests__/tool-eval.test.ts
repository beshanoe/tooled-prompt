import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
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

  it('description includes @returns with string returns', () => {
    function sum(a: string, b: string) {
      return String(Number(a) + Number(b));
    }
    const wrapped = tool(sum, {
      description: 'Add two numbers',
      args: [
        ['a', 'First number'],
        ['b', 'Second number'],
      ],
      returns: 'The sum as a string',
    });
    const exec = toolEval(wrapped);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('@returns The sum as a string');
  });

  it('description includes @returns {type} with Zod returns', () => {
    function findUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    const wrapped = tool(findUser, {
      returns: z.object({ name: z.string(), id: z.number() }).describe('A user record'),
    });
    const exec = toolEval(wrapped);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('@returns {{ name: string, id: number }} A user record');
  });

  it('params include {type} and optionality', () => {
    function search(query: string, limit = 10) {
      return `${query}:${limit}`;
    }
    const wrapped = tool(search, {
      args: [
        ['query', 'Search query'],
        ['limit', 'Max results'],
      ],
    });
    const exec = toolEval(wrapped);
    const desc = exec[TOOL_SYMBOL].description;
    expect(desc).toContain('@param {string} query - Search query');
    expect(desc).toContain('@param {string} [limit] - Max results');
  });

  describe('object-typed params/returns expand to dotted JSDoc lines', () => {
    it('expands object @param fields to canonical dot notation when any field has a description', () => {
      function createUser(opts: { name: string; age?: number }) {
        return opts;
      }
      const wrapped = tool(createUser, {
        args: [
          z.object({
            name: z.string().describe("The user's name"),
            age: z.number().optional().describe('Optional age'),
          }),
        ],
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      expect(desc).toContain('@param {Object} opts');
      expect(desc).toContain("@param {string} opts.name - The user's name");
      expect(desc).toContain('@param {number} [opts.age] - Optional age');
    });

    it('promotes object @returns to a @typedef block referenced by name', () => {
      function getReminder(_id: number): { id: number; dueAt: string | null } {
        return { id: 1, dueAt: null };
      }
      const wrapped = tool(getReminder, {
        returns: z.object({
          id: z.number(),
          dueAt: z.string().describe('Local time YYYY-MM-DD HH:mm:ss').nullable(),
        }),
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      expect(desc).toContain('@typedef {Object} T1');
      expect(desc).toContain('@property {number} id');
      expect(desc).toContain('@property {string | null} dueAt - Local time YYYY-MM-DD HH:mm:ss');
      expect(desc).toContain('@returns {T1}');
      // Dotted @returns is non-standard and should no longer appear
      expect(desc).not.toMatch(/@returns \{.*\} returns\./);
    });

    it('promotes array-of-object @returns and references as T1[]', () => {
      function listReminders() {
        return [] as { id: number; dueAt: string | null }[];
      }
      const wrapped = tool(listReminders, {
        returns: z.array(
          z.object({
            id: z.number(),
            dueAt: z.string().describe('Local time YYYY-MM-DD HH:mm:ss').nullable(),
          }),
        ),
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      expect(desc).toContain('@typedef {Object} T1');
      expect(desc).toContain('@property {number} id');
      expect(desc).toContain('@property {string | null} dueAt - Local time YYYY-MM-DD HH:mm:ss');
      expect(desc).toContain('@returns {T1[]}');
      expect(desc).not.toMatch(/@returns \{.*\} returns\[?\]?\./);
    });

    it('deduplicates shared shapes across multiple tools into one typedef', () => {
      const Reminder = z.object({
        id: z.number(),
        dueAt: z.string().describe('Local time YYYY-MM-DD HH:mm:ss').nullable(),
      });
      function getReminder(_id: number): { id: number; dueAt: string | null } {
        return { id: 1, dueAt: null };
      }
      function listReminders(): { id: number; dueAt: string | null }[] {
        return [];
      }
      const one = tool(getReminder, { returns: Reminder });
      const many = tool(listReminders, { returns: z.array(Reminder) });
      const exec = toolEval(one, many);
      const desc = exec[TOOL_SYMBOL].description;
      // Exactly one @typedef block for the shared shape
      expect(desc.match(/@typedef \{Object\} T\d+/g)).toHaveLength(1);
      // Both signatures reference it
      expect(desc).toContain('@returns {T1}');
      expect(desc).toContain('@returns {T1[]}');
    });

    it('promoted typedef references dedup shared nested shapes by name', () => {
      const TimeRange = z.object({
        start: z.string().describe('ISO timestamp'),
        end: z.string(),
      });
      function findOne(_q: string): { id: number; window: { start: string; end: string } } {
        return { id: 1, window: { start: '', end: '' } };
      }
      function findMany(_q: string): { id: number; window: { start: string; end: string } }[] {
        return [];
      }
      const one = tool(findOne, { returns: z.object({ id: z.number(), window: TimeRange }) });
      const many = tool(findMany, {
        returns: z.array(z.object({ id: z.number(), window: TimeRange })),
      });
      const exec = toolEval(one, many);
      const desc = exec[TOOL_SYMBOL].description;
      // TimeRange appears twice so it gets its own typedef, referenced by the
      // outer typedef's `window` property instead of inlined.
      const typedefCount = (desc.match(/@typedef \{Object\} T\d+/g) || []).length;
      expect(typedefCount).toBeGreaterThanOrEqual(2);
      // Outer typedef references the inner one
      expect(desc).toMatch(/@property \{T\d+\} window/);
      // Inner typedef defines the ISO timestamp description
      expect(desc).toContain('@property {string} start - ISO timestamp');
    });

    it('promotes a large single-use @param shape to a typedef when dotted expansion would outweigh it', () => {
      function upsertEntity(input: {
        id: string;
        name: string;
        description: string;
        tags: string[];
        priority: number;
      }) {
        return input;
      }
      const wrapped = tool(upsertEntity, {
        args: [
          z.object({
            id: z.string().describe('Unique ID'),
            name: z.string().describe('Display name'),
            description: z.string().describe('Free-form description'),
            tags: z.array(z.string()).describe('Tag list'),
            priority: z.number().describe('Sort priority'),
          }),
        ],
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      // Single-use shape with 5 described fields → promoted, not dot-expanded
      expect(desc).toContain('@typedef {Object} T1');
      expect(desc).toContain('@property {string} id - Unique ID');
      expect(desc).toContain('@param {T1} input');
      expect(desc).not.toContain('input.id');
      expect(desc).not.toContain('input.name');
    });

    it('keeps small single-use @param shapes inline (below promotion threshold)', () => {
      function createUser(opts: { name: string; age?: number }) {
        return opts;
      }
      const wrapped = tool(createUser, {
        args: [
          z.object({
            name: z.string().describe("The user's name"),
            age: z.number().optional().describe('Optional age'),
          }),
        ],
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      // 2 fields → below threshold → stays as dotted inline expansion
      expect(desc).not.toContain('@typedef');
      expect(desc).toContain('@param {Object} opts');
      expect(desc).toContain("@param {string} opts.name - The user's name");
    });

    it('saves tokens vs full dotted expansion on a multi-tool fixture', () => {
      const Reminder = z.object({
        id: z.number(),
        title: z.string().describe('Reminder title'),
        dueAt: z.string().describe('Local time YYYY-MM-DD HH:mm:ss').nullable(),
        tags: z.array(z.string()),
      });
      type R = { id: number; title: string; dueAt: string | null; tags: string[] };
      function getReminder(_id: number): R {
        return { id: 1, title: '', dueAt: null, tags: [] };
      }
      function listReminders(): R[] {
        return [];
      }
      function createReminder(_input: { title: string }): R {
        return { id: 1, title: '', dueAt: null, tags: [] };
      }
      const exec = toolEval(
        tool(getReminder, { returns: Reminder }),
        tool(listReminders, { returns: z.array(Reminder) }),
        tool(createReminder, { returns: Reminder }),
      );
      const desc = exec[TOOL_SYMBOL].description;
      // Single typedef for Reminder, three references — clearly shorter than
      // inlining the three described properties three times over.
      const typedefMatches = desc.match(/@typedef \{Object\} T1/g) || [];
      expect(typedefMatches).toHaveLength(1);
      const t1Refs = desc.match(/\{T1(?:\[\])?\}/g) || [];
      expect(t1Refs.length).toBeGreaterThanOrEqual(3);
    });

    it('keeps compact inline type when no nested descriptions exist', () => {
      function findUser(id: string): { name: string; id: number } {
        return { name: 'Alice', id: Number(id) };
      }
      const wrapped = tool(findUser, {
        returns: z.object({ name: z.string(), id: z.number() }).describe('A user record'),
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      expect(desc).toContain('@returns {{ name: string, id: number }} A user record');
      expect(desc).not.toMatch(/@returns \{.*\} returns\./);
    });

    it('recurses into nested objects with dotted paths', () => {
      function withAddress(data: { user: { name: string; city: string } }) {
        return data;
      }
      const wrapped = tool(withAddress, {
        args: [
          z.object({
            user: z.object({
              name: z.string(),
              city: z.string().describe('City name'),
            }),
          }),
        ],
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      expect(desc).toContain('@param {string} data.user.city - City name');
    });

    it('renders destructured-param tools with a clean synthetic param name', () => {
      // This was previously broken: destructured params parsed as `"{a"` and
      // polluted all dotted lines (e.g. `{a.field`). They should render as `args0`.
      function markDone({ id, stop }: { id: number; stop?: boolean }) {
        return stop ? `stopped ${id}` : `done ${id}`;
      }
      const wrapped = tool(markDone, {
        args: [
          z.object({
            id: z.number().describe('Reminder ID'),
            stop: z.boolean().optional().describe('Stop recurring'),
          }),
        ],
      });
      const exec = toolEval(wrapped);
      const desc = exec[TOOL_SYMBOL].description;
      // Clean synthetic name — no `{` leak
      expect(desc).not.toContain('{id.');
      expect(desc).not.toContain('{args0');
      expect(desc).toContain('@param {Object} args0');
      expect(desc).toContain('@param {number} args0.id - Reminder ID');
      expect(desc).toContain('@param {boolean} [args0.stop] - Stop recurring');
    });
  });

  it('auto-parses return values when tool has Zod returns schema', async () => {
    function lookupUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    tool(lookupUser, {
      returns: z.object({ name: z.string(), id: z.number() }),
    });
    const exec = toolEval(lookupUser);
    // The eval code accesses .name directly — parseReturn validates
    const result = await exec('const user = await lookupUser("1"); return user.name;');
    expect(result).toBe('Alice');
  });

  it('auto-parses async tool return values', async () => {
    async function fetchItems(category: string): Promise<Array<{ name: string }>> {
      return [{ name: category }];
    }
    tool(fetchItems, {
      returns: z.array(z.object({ name: z.string() })),
    });
    const exec = toolEval(fetchItems);
    const result = await exec('const items = await fetchItems("books"); return items[0].name;');
    expect(result).toBe('books');
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

  it('passes Uint8Array through as-is for image support', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    function getImage() {
      return pngBytes;
    }
    const exec = toolEval(getImage);
    const result = await exec('return await getImage()');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toBe(pngBytes);
  });

  it('calls result if LLM wraps code in an arrow function', async () => {
    const exec = toolEval(add);
    const result = await exec('async () => {\n  return await add("1", "2");\n}');
    expect(result).toBe('3');
  });

  it('calls result if LLM wraps code in an arrow with expression body', async () => {
    const exec = toolEval(add);
    const result = await exec('() => add("3", "4")');
    expect(result).toBe('7');
  });

  it('calls result if LLM wraps code in a function expression', async () => {
    const exec = toolEval(add);
    const result = await exec('(async function() {\n  return await add("5", "6");\n})');
    expect(result).toBe('11');
  });

  it('returns error message on code error', async () => {
    const exec = toolEval(add);
    const result = await exec('throw new Error("boom")');
    expect(result).toBe('Error: boom');
  });

  it('returns annotated error on syntax error', async () => {
    const exec = toolEval(add);
    const result = await exec('const x = 1;\nconst y = ;\nreturn x');
    expect(result).toContain('SyntaxError:');
    expect(result).toContain('> 2 |');
    expect(result).toContain('^');
  });

  it('times out when code hangs', async () => {
    const exec = toolEval(add, { timeout: 50 });
    const result = await exec('await new Promise(r => setTimeout(r, 5000)); return "late"');
    expect(result).toContain('Timed out');
  });

  describe('auto-return preprocessing', () => {
    it('auto-returns a bare expression', async () => {
      const exec = toolEval(add);
      const result = await exec('add("2", "3")');
      expect(result).toBe('5');
    });

    it('auto-returns a bare await expression', async () => {
      async function asyncAdd(a: string, b: string) {
        return String(Number(a) + Number(b));
      }
      const exec = toolEval(asyncAdd);
      const result = await exec('await asyncAdd("10", "20")');
      expect(result).toBe('30');
    });

    it('auto-calls a single uncalled function', async () => {
      const exec = toolEval(add);
      const result = await exec('async function main() {\n  return add("2", "3");\n}');
      expect(result).toBe('5');
    });

    it('auto-calls the uncalled function when helpers are called', async () => {
      const exec = toolEval(add, multiply);
      const result = await exec(`
        function helper(x) { return multiply(x, "2"); }
        async function main() {
          const sum = add("3", "4");
          return helper(sum);
        }
      `);
      expect(result).toBe('14');
    });

    it('does not guess when multiple functions are uncalled', async () => {
      const exec = toolEval(add);
      const result = await exec('function a() { return add("1","2"); }\nfunction b() { return add("3","4"); }');
      expect(result).toBe('OK');
    });

    it('still works with explicit return (regression)', async () => {
      const exec = toolEval(add);
      const result = await exec('return add("2", "3")');
      expect(result).toBe('5');
    });
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
