import { describe, it, expect, beforeEach } from 'vitest';
import { tool, isTool, getToolMetadata, resetAnonymousCounter, TOOL_SYMBOL } from '../tool.js';
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
      expect(getToolMetadata(wrapped).name).toBe('fetchData');
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
  });

  describe('object syntax { fn }', () => {
    it('extracts name from object key', () => {
      const myFunc = (x: string) => x.toUpperCase();
      const wrapped = tool({ myFunc });
      expect(getToolMetadata(wrapped).name).toBe('myFunc');
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

describe('TOOL_SYMBOL', () => {
  it('is the correct symbol', () => {
    expect(TOOL_SYMBOL).toBe(Symbol.for('tooled-prompt.tool'));
  });
});
