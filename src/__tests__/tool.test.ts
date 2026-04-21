import { describe, it, expect, beforeEach } from 'vitest';
import { tool, isTool, getToolMetadata, resetAnonymousCounter, TOOL_SYMBOL, jsonSchemaToTypeString } from '../tool.js';
import { z } from 'zod';

describe('tool', () => {
  beforeEach(() => {
    resetAnonymousCounter();
  });

  describe('basic wrapping', () => {
    it('wraps a function with auto-inferred metadata', () => {
      function greet(name: string) {
        return `Hello, ${name}!`;
      }
      const wrapped = tool(greet);
      expect(isTool(wrapped)).toBe(true);
      const metadata = getToolMetadata(wrapped);
      expect(metadata.name).toBe('greet');
      expect(metadata.description).toBe('The greet function');
      expect(metadata.parameters.properties).toHaveProperty('name');
    });

    it('wraps async functions', () => {
      async function fetchData(url: string) {
        return url;
      }
      const wrapped = tool(fetchData);
      expect(isTool(wrapped)).toBe(true);
      expect(getToolMetadata(wrapped).name).toBe('fetch_data');
    });

    it('returns same function if already a tool', () => {
      function fn(x: string) {
        return x;
      }
      const wrapped1 = tool(fn);
      const wrapped2 = tool(wrapped1);
      expect(wrapped1).toBe(wrapped2);
    });

    it('assigns tool_N name to anonymous functions', () => {
      const wrapped1 = tool((x: string) => x);
      const wrapped2 = tool((y: string) => y);
      expect(getToolMetadata(wrapped1).name).toBe('tool_1');
      expect(getToolMetadata(wrapped2).name).toBe('tool_2');
    });

    it('auto-infers default param as optional', () => {
      function search(query: string, limit = 10) {
        return `${query}:${limit}`;
      }
      const wrapped = tool(search);
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties).toHaveProperty('query');
      expect(metadata.parameters.properties).toHaveProperty('limit');
      expect(metadata.parameters.required).toContain('query');
      expect(metadata.parameters.required).not.toContain('limit');
    });
  });

  describe('with description', () => {
    it('uses provided description', () => {
      function add(a: number, b: number) {
        return a + b;
      }
      const wrapped = tool(add, { description: 'Adds two numbers' });
      expect(getToolMetadata(wrapped).description).toBe('Adds two numbers');
    });
  });

  describe('with string array args', () => {
    it('creates schema from single string descriptor', () => {
      function getWeather(city: string) {
        return city;
      }
      const wrapped = tool(getWeather, { args: ['The city name'] });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.city).toEqual({
        type: 'string',
        description: 'The city name',
      });
    });

    it('maps array to parameter names', () => {
      function copyFile(src: string, dest: string) {
        return `${src} -> ${dest}`;
      }
      const wrapped = tool(copyFile, { args: ['Source path', 'Destination path'] });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.src.description).toBe('Source path');
      expect(metadata.parameters.properties.dest.description).toBe('Destination path');
    });

    it('marks params with defaults as optional', () => {
      function search(query: string, limit = 10) {
        return `${query}:${limit}`;
      }
      const wrapped = tool(search, { args: ['Search term', 'Max results'] });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.required).toContain('query');
      expect(metadata.parameters.required).not.toContain('limit');
    });
  });

  describe('with tuple [name, desc] args', () => {
    it('uses explicit names from tuples', () => {
      function search(query: string, limit: number) {
        return `${query}:${limit}`;
      }
      const wrapped = tool(search, {
        args: [
          ['query', 'Search term'],
          ['limit', 'Max results'],
        ],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.query.description).toBe('Search term');
      expect(metadata.parameters.properties.limit.description).toBe('Max results');
      expect(metadata.parameters.required).toContain('query');
      expect(metadata.parameters.required).toContain('limit');
    });

    it('handles optional params with tuple descriptors', () => {
      function search(query: string, limit = 10) {
        return `${query}:${limit}`;
      }
      const wrapped = tool(search, {
        args: [
          ['query', 'Search term'],
          ['limit', 'Max results (optional)'],
        ],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.required).toContain('query');
      expect(metadata.parameters.required).not.toContain('limit');
    });
  });

  describe('with Zod schema args', () => {
    it('converts Zod array with z.object element to JSON Schema', () => {
      function takesObject(data: { name: string; email: string }) {
        return data;
      }
      const wrapped = tool(takesObject, {
        args: [
          z.object({
            name: z.string().describe('User name'),
            email: z.string().describe('User email'),
          }),
        ],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.data).toBeDefined();
      // The nested object schema should be preserved
      const dataProp = metadata.parameters.properties.data as any;
      expect(dataProp.type).toBe('object');
      expect(dataProp.properties.name.description).toBe('User name');
      expect(dataProp.properties.email.description).toBe('User email');
    });

    it('converts Zod array to JSON Schema with param names', () => {
      function calculate(a: number, b: number) {
        return a + b;
      }
      const wrapped = tool(calculate, {
        args: [z.number().describe('First number'), z.number().describe('Second number')],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.a.description).toBe('First number');
      expect(metadata.parameters.properties.b.description).toBe('Second number');
    });
  });

  describe('with mixed descriptors', () => {
    it('supports string + Zod in same array', () => {
      function fn(name: string, count: number) {
        return name.repeat(count);
      }
      const wrapped = tool(fn, {
        args: ['The name', z.number().describe('Repeat count')],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.name).toEqual({
        type: 'string',
        description: 'The name',
      });
      expect((metadata.parameters.properties.count as any).description).toBe('Repeat count');
    });

    it('supports tuple + Zod in same array', () => {
      function fn(name: string, count: number) {
        return name.repeat(count);
      }
      const wrapped = tool(fn, {
        args: [['name', 'The name'], z.number().describe('Repeat count')],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.properties.name).toEqual({
        type: 'string',
        description: 'The name',
      });
      expect((metadata.parameters.properties.count as any).description).toBe('Repeat count');
    });
    it('marks z.optional() args as not required', () => {
      const wrapped = tool((name: string, title?: string) => `${title} ${name}`, {
        args: [z.string().describe('Full name'), z.string().optional().describe('Optional title')],
      });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.parameters.required).toEqual(['name']);
    });
  });

  describe('object syntax { fn }', () => {
    it('extracts name from object key', () => {
      const myFunc = (x: string) => x.toUpperCase();
      const wrapped = tool({ myFunc });
      expect(getToolMetadata(wrapped).name).toBe('my_func');
    });

    it('works with options', () => {
      const transform = (input: string) => input.toLowerCase();
      const wrapped = tool({ transform }, { description: 'Transform text', args: ['Input text'] });
      const metadata = getToolMetadata(wrapped);
      expect(metadata.name).toBe('transform');
      expect(metadata.description).toBe('Transform text');
      expect(metadata.parameters.properties.input.description).toBe('Input text');
    });

    it('throws if object has multiple keys', () => {
      const fn1 = (x: string) => x;
      const fn2 = (y: string) => y;
      expect(() => tool({ fn1, fn2 } as any)).toThrow('exactly one function');
    });

    it('throws if object value is not a function', () => {
      expect(() => tool({ notAFunc: 123 } as any)).toThrow('must be a function');
    });
  });
});

describe('isTool', () => {
  it('returns true for tool-wrapped functions', () => {
    function fn() {}
    expect(isTool(fn)).toBe(false);
    const wrapped = tool(fn);
    expect(isTool(wrapped)).toBe(true);
  });

  it('returns false for non-functions', () => {
    expect(isTool('string')).toBe(false);
    expect(isTool(123)).toBe(false);
    expect(isTool(null)).toBe(false);
    expect(isTool(undefined)).toBe(false);
    expect(isTool({})).toBe(false);
  });
});

describe('getToolMetadata', () => {
  it('returns metadata from tool function', () => {
    function greet(name: string) {
      return name;
    }
    const wrapped = tool(greet, { description: 'Greets someone' });
    const metadata = getToolMetadata(wrapped);
    expect(metadata.name).toBe('greet');
    expect(metadata.description).toBe('Greets someone');
    expect(metadata.parameters).toBeDefined();
  });
});

describe('wrapped function execution', () => {
  it('wrapped sync function can be called and returns correct value', () => {
    function add(a: number, b: number) {
      return a + b;
    }
    const wrapped = tool(add);

    expect(wrapped(2, 3)).toBe(5);
    expect(wrapped(-1, 1)).toBe(0);
    expect(wrapped(100, 200)).toBe(300);
  });

  it('wrapped async function can be called and returns promise', async () => {
    async function asyncGreet(name: string) {
      return `Hello, ${name}!`;
    }
    const wrapped = tool(asyncGreet);

    const result = await wrapped('World');
    expect(result).toBe('Hello, World!');
  });

  it('wrapped function with multiple args receives all arguments', () => {
    const received: unknown[] = [];
    function captureArgs(a: string, b: number, c: boolean) {
      received.push(a, b, c);
      return 'captured';
    }
    const wrapped = tool(captureArgs);

    wrapped('test', 42, true);

    expect(received).toEqual(['test', 42, true]);
  });

  it('wrapped function can throw errors', () => {
    function failing() {
      throw new Error('Test error');
    }
    const wrapped = tool(failing);

    expect(() => wrapped()).toThrow('Test error');
  });

  it('wrapped function preserves function identity', () => {
    function original(x: string) {
      return x.toUpperCase();
    }
    const wrapped = tool(original);

    // The wrapped function should behave identically
    expect(wrapped('hello')).toBe(original('hello'));
    expect(wrapped('WORLD')).toBe(original('WORLD'));
  });

  it('wrapped function can access closure variables', () => {
    let counter = 0;
    function increment() {
      counter++;
      return counter;
    }
    const wrapped = tool(increment);

    expect(wrapped()).toBe(1);
    expect(wrapped()).toBe(2);
    expect(counter).toBe(2);
  });

  it('wrapped arrow function works correctly', () => {
    const multiply = (a: number, b: number) => a * b;
    const wrapped = tool({ multiply });

    expect(wrapped(3, 4)).toBe(12);
    expect(wrapped(0, 100)).toBe(0);
  });
});

describe('returns option', () => {
  it('stores string returns in metadata', () => {
    function add(a: string, b: string) {
      return String(Number(a) + Number(b));
    }
    const wrapped = tool(add, { returns: 'The sum as a string' });
    const meta = getToolMetadata(wrapped);
    expect(meta.returns).toBe('The sum as a string');
  });

  it('does not append returns to description', () => {
    function add(a: string, b: string) {
      return String(Number(a) + Number(b));
    }
    const wrapped = tool(add, { description: 'Add two numbers', returns: 'The sum as a string' });
    const meta = getToolMetadata(wrapped);
    expect(meta.description).toBe('Add two numbers');
  });

  it('resolves Zod string schema to type and description', () => {
    function greet(name: string) {
      return `Hello, ${name}`;
    }
    const wrapped = tool(greet, { returns: z.string().describe('A greeting message') });
    const meta = getToolMetadata(wrapped);
    expect(meta.returns).toBe('A greeting message');
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('string');
  });

  it('resolves Zod object schema to type shape', () => {
    function getUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    const wrapped = tool(getUser, {
      returns: z.object({ name: z.string(), id: z.number() }),
    });
    const meta = getToolMetadata(wrapped);
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('{ name: string, id: number }');
    expect(meta.returns).toBeUndefined();
  });

  it('resolves Zod object schema with description', () => {
    function fetchUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    const wrapped = tool(fetchUser, {
      returns: z.object({ name: z.string(), id: z.number() }).describe('A user record'),
    });
    const meta = getToolMetadata(wrapped);
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('{ name: string, id: number }');
    expect(meta.returns).toBe('A user record');
  });

  it('marks optional fields with ? in object type string', () => {
    function getProfile(_id: string): { name: string; bio?: string; age?: number } {
      return { name: 'Alice' };
    }
    const wrapped = tool(getProfile, {
      returns: z.object({ name: z.string(), bio: z.string().optional(), age: z.number().optional() }),
    });
    const meta = getToolMetadata(wrapped);
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('{ name: string, bio?: string, age?: number }');
  });

  it('resolves Zod array schema', () => {
    function listNames(): string[] {
      return ['a', 'b'];
    }
    const wrapped = tool(listNames, { returns: z.array(z.string()) });
    const meta = getToolMetadata(wrapped);
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('string[]');
  });

  it('metadata.returns is undefined when not provided', () => {
    function add(a: string) {
      return a;
    }
    const wrapped = tool(add);
    const meta = getToolMetadata(wrapped);
    expect(meta.returns).toBeUndefined();
    expect(meta.parseReturn).toBeUndefined();
  });

  it('sets parseReturn for Zod schema', () => {
    function getUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    const wrapped = tool(getUser, {
      returns: z.object({ name: z.string(), id: z.number() }),
    });
    const meta = getToolMetadata(wrapped);
    expect(meta.parseReturn).toBeTypeOf('function');
  });

  it('parseReturn validates object return', () => {
    function getUser(id: string): { name: string; id: number } {
      return { name: 'Alice', id: Number(id) };
    }
    const wrapped = tool(getUser, {
      returns: z.object({ name: z.string(), id: z.number() }),
    });
    const result = wrapped('1');
    const parsed = getToolMetadata(wrapped).parseReturn!(result);
    expect(parsed).toEqual({ name: 'Alice', id: 1 });
  });

  it('parseReturn passes through matching types', () => {
    function greet(name: string): string {
      return `Hello, ${name}`;
    }
    const wrapped = tool(greet, { returns: z.string() });
    const parsed = getToolMetadata(wrapped).parseReturn!(wrapped('Alice'));
    expect(parsed).toBe('Hello, Alice');
  });

  it('parseReturn throws on invalid data', () => {
    function bad(): { wrong: string } {
      return { wrong: 'shape' };
    }
    const wrapped = tool(bad as any, {
      returns: z.object({ name: z.string() }) as any,
    });
    expect(() => getToolMetadata(wrapped).parseReturn!(wrapped())).toThrow();
  });

  it('does not set parseReturn for string returns', () => {
    function add(a: string) {
      return a;
    }
    const wrapped = tool(add, { returns: 'a string result' });
    expect(getToolMetadata(wrapped).parseReturn).toBeUndefined();
  });
});

describe('jsonSchemaToTypeString', () => {
  it('converts string enum to union type', () => {
    expect(jsonSchemaToTypeString({ enum: ['a', 'b', 'c'] })).toBe('"a" | "b" | "c"');
  });

  it('converts numeric enum to union type', () => {
    expect(jsonSchemaToTypeString({ enum: [1, 2, 3] })).toBe('1 | 2 | 3');
  });

  it('converts mixed enum to union type', () => {
    expect(jsonSchemaToTypeString({ enum: ['a', 1, null] })).toBe('"a" | 1 | null');
  });

  it('converts single-value enum', () => {
    expect(jsonSchemaToTypeString({ enum: ['only'] })).toBe('"only"');
  });

  it('enum takes precedence over type field', () => {
    expect(jsonSchemaToTypeString({ type: 'string', enum: ['x', 'y'] })).toBe('"x" | "y"');
  });

  it('z.enum() arg produces correct enum schema in parameters', () => {
    function pick(choice: string) {
      return choice;
    }
    const wrapped = tool(pick, { args: [z.enum(['foo', 'bar']).describe('Pick one')] });
    const meta = getToolMetadata(wrapped);
    const choiceProp = meta.parameters.properties.choice as Record<string, unknown>;
    expect(choiceProp.enum).toEqual(['foo', 'bar']);
    expect(jsonSchemaToTypeString(choiceProp)).toBe('"foo" | "bar"');
  });

  it('z.enum() in returns produces correct type string', () => {
    function getStatus(_id: string): string {
      return 'active';
    }
    const wrapped = tool(getStatus, {
      returns: z.enum(['active', 'inactive', 'pending']).describe('Account status'),
    });
    const meta = getToolMetadata(wrapped);
    expect(meta.returns).toBe('Account status');
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe('"active" | "inactive" | "pending"');
  });

  it('enum inside object property', () => {
    expect(
      jsonSchemaToTypeString({
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { enum: ['active', 'inactive'] },
        },
        required: ['name', 'status'],
      }),
    ).toBe('{ name: string, status: "active" | "inactive" }');
  });

  it('array of enum values', () => {
    expect(
      jsonSchemaToTypeString({
        type: 'array',
        items: { enum: ['red', 'green', 'blue'] },
      }),
    ).toBe('"red" | "green" | "blue"[]');
  });

  it('z.object with z.enum field produces correct nested type string', () => {
    function createItem(data: { name: string; category: string }) {
      return data;
    }
    const wrapped = tool(createItem, {
      returns: z.object({
        name: z.string(),
        category: z.enum(['Features', 'Fixes', 'Other']),
      }),
    });
    const meta = getToolMetadata(wrapped);
    expect(jsonSchemaToTypeString(meta.returnsSchema!)).toBe(
      '{ name: string, category: "Features" | "Fixes" | "Other" }',
    );
  });
});

describe('jsonSchemaToTypeString — anyOf/oneOf unions', () => {
  it('renders anyOf of primitives as a union', () => {
    expect(jsonSchemaToTypeString({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toBe('string | number');
  });

  it('renders nullable (anyOf with null) as `T | null`', () => {
    expect(jsonSchemaToTypeString({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
  });

  it('renders oneOf the same as anyOf', () => {
    expect(jsonSchemaToTypeString({ oneOf: [{ type: 'boolean' }, { type: 'null' }] })).toBe('boolean | null');
  });

  it('renders nullable inside an object property', () => {
    expect(
      jsonSchemaToTypeString({
        type: 'object',
        properties: {
          dueAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['dueAt'],
      }),
    ).toBe('{ dueAt: string | null }');
  });
});

describe('TOOL_SYMBOL', () => {
  it('is the correct symbol', () => {
    expect(TOOL_SYMBOL).toBe(Symbol.for('tooled-prompt.tool'));
  });
});
