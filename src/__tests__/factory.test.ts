import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTooledPrompt } from '../factory.js';
import { tool } from '../tool.js';

describe('createTooledPrompt', () => {
  describe('instance creation', () => {
    it('creates an instance with default config', () => {
      const instance = createTooledPrompt();
      expect(instance.prompt).toBeInstanceOf(Function);
      expect(instance.tool).toBeInstanceOf(Function);
      expect(instance.setConfig).toBeInstanceOf(Function);
      expect(instance.on).toBeInstanceOf(Function);
      expect(instance.off).toBeInstanceOf(Function);
    });

    it('creates instance with custom config', () => {
      const instance = createTooledPrompt({
        apiUrl: 'https://custom.api.com/v1',
        apiKey: 'test-key',
      });
      expect(instance).toBeDefined();
    });
  });

  describe('config validation', () => {
    it('throws on invalid temperature (too low)', () => {
      expect(() => createTooledPrompt({ temperature: -0.1 })).toThrow('temperature must be between 0 and 2');
    });

    it('throws on invalid temperature (too high)', () => {
      expect(() => createTooledPrompt({ temperature: 2.5 })).toThrow('temperature must be between 0 and 2');
    });

    it('throws on invalid maxIterations (zero)', () => {
      expect(() => createTooledPrompt({ maxIterations: 0 })).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid maxIterations (negative)', () => {
      expect(() => createTooledPrompt({ maxIterations: -5 })).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid maxIterations (float)', () => {
      expect(() => createTooledPrompt({ maxIterations: 5.5 })).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid timeout (negative)', () => {
      expect(() => createTooledPrompt({ timeout: -1000 })).toThrow('timeout must be a positive number');
    });

    it('throws on invalid timeout (Infinity)', () => {
      expect(() => createTooledPrompt({ timeout: Infinity })).toThrow('timeout must be a positive number');
    });

    it('accepts valid config values', () => {
      expect(() =>
        createTooledPrompt({
          temperature: 0,
          maxIterations: 1,
          timeout: 0,
        }),
      ).not.toThrow();

      expect(() =>
        createTooledPrompt({
          temperature: 2,
          maxIterations: 100,
          timeout: 300000,
        }),
      ).not.toThrow();
    });
  });

  describe('setConfig validation', () => {
    it('validates config on setConfig', () => {
      const instance = createTooledPrompt();
      expect(() => instance.setConfig({ temperature: 3 })).toThrow('temperature must be between 0 and 2');
    });

    it('allows valid setConfig', () => {
      const instance = createTooledPrompt();
      expect(() => instance.setConfig({ temperature: 1.5 })).not.toThrow();
    });
  });

  describe('event handling', () => {
    it('allows subscribing to events', () => {
      const instance = createTooledPrompt();
      const handler = vi.fn();
      instance.on('content', handler);
      // Handler is registered (no error)
      expect(true).toBe(true);
    });

    it('allows unsubscribing from events', () => {
      const instance = createTooledPrompt();
      const handler = vi.fn();
      instance.on('content', handler);
      instance.off('content', handler);
      // Handler is unregistered (no error)
      expect(true).toBe(true);
    });
  });

  describe('config application in API requests', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' } }],
        }),
      });
      globalThis.fetch = mockFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('uses apiUrl in fetch request', async () => {
      const instance = createTooledPrompt({
        apiUrl: 'https://test-api.example.com/v1',
        silent: true,
      });

      await instance.prompt`Test`();

      expect(mockFetch).toHaveBeenCalledWith('https://test-api.example.com/v1/chat/completions', expect.any(Object));
    });

    it('uses apiKey in Authorization header', async () => {
      const instance = createTooledPrompt({
        apiKey: 'sk-test-key-12345',
        silent: true,
      });

      await instance.prompt`Test`();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key-12345',
          }),
        }),
      );
    });

    it('uses modelName in request body', async () => {
      const instance = createTooledPrompt({
        modelName: 'gpt-4-turbo',
        silent: true,
      });

      await instance.prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4-turbo');
    });

    it('uses temperature in request body', async () => {
      const instance = createTooledPrompt({
        temperature: 0.8,
        silent: true,
      });

      await instance.prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.temperature).toBe(0.8);
    });

    it('uses stream setting in request body', async () => {
      const instance = createTooledPrompt({
        stream: true,
        silent: true,
      });

      // Mock streaming response
      const encoder = new TextEncoder();
      mockFetch.mockResolvedValue({
        ok: true,
        body: {
          getReader: () => {
            let called = false;
            return {
              read: async () => {
                if (!called) {
                  called = true;
                  return {
                    done: false,
                    value: encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n'),
                  };
                }
                return { done: true, value: undefined };
              },
            };
          },
        },
      });

      await instance.prompt`Test`();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(true);
    });

    it('setConfig updates values used in subsequent requests', async () => {
      const instance = createTooledPrompt({
        modelName: 'initial-model',
        silent: true,
      });

      // First request
      await instance.prompt`First`();
      let body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('initial-model');

      // Update config
      instance.setConfig({ modelName: 'updated-model', temperature: 0.9 });

      // Second request
      await instance.prompt`Second`();
      body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.model).toBe('updated-model');
      expect(body.temperature).toBe(0.9);
    });

    it('per-call config overrides instance config', async () => {
      const instance = createTooledPrompt({
        modelName: 'instance-model',
        temperature: 0.5,
        silent: true,
      });

      await instance.prompt`Test`({ modelName: 'call-model', temperature: 0.9 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('call-model');
      expect(body.temperature).toBe(0.9);
    });
  });

  describe('next (conversation continuation)', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' } }],
        }),
      });
      globalThis.fetch = mockFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('returns next in PromptResult', async () => {
      const instance = createTooledPrompt({ silent: true });
      const result = await instance.prompt`Hello`();

      expect(result.next).toBeInstanceOf(Function);
      expect(result.next.return).toBeDefined();
    });

    it('next carries conversation history', async () => {
      const instance = createTooledPrompt({ silent: true });

      // First call
      const { next } = await instance.prompt`Hello`();

      // Second call via next
      await next`Follow up`();

      // Second fetch should include conversation history
      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      // Messages should be: [user "Hello", assistant "OK", user "Follow up"]
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0].role).toBe('user');
      expect(body.messages[1].role).toBe('assistant');
      expect(body.messages[1].content).toBe('OK');
      expect(body.messages[2].role).toBe('user');
    });

    it('next preserves tools from previous call', async () => {
      const instance = createTooledPrompt({ silent: true });
      const sayHi = (name: string) => `Hi ${name}`;
      const sayHiTool = tool({ sayHi });

      const { next } = await instance.prompt`Use ${sayHiTool}`();

      // Call next without the tool in template
      await next`Do something else`();

      // Second request should still include sayHi tool
      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolNames = (body.tools || []).map((t: any) => t.function.name);
      expect(toolNames).toContain('sayHi');
    });

    it('next deduplicates tools by name (new wins)', async () => {
      const instance = createTooledPrompt({ silent: true });
      const myGreet1 = (name: string) => `Hi ${name}`;
      const greetV1 = tool({ myGreet1 }, { description: 'v1' });

      const { next } = await instance.prompt`Use ${greetV1}`();

      // Override with same tool name but new implementation
      const myGreet1v2 = (name: string) => `Hello ${name}`;
      // Use explicit name to match
      const greetV2 = tool({ myGreet1: myGreet1v2 }, { description: 'v2' });
      await next`Use ${greetV2}`();

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const greetTools = (body.tools || []).filter((t: any) => t.function.name === 'myGreet1');
      expect(greetTools).toHaveLength(1);
      expect(greetTools[0].function.description).toBe('v2');
    });

    it('next can add new tools', async () => {
      const instance = createTooledPrompt({ silent: true });
      const greetPerson = (name: string) => `Hi ${name}`;
      const greetTool = tool({ greetPerson });

      const { next } = await instance.prompt`Use ${greetTool}`();

      const wavePerson = () => 'bye';
      const waveTool = tool({ wavePerson });
      await next`Also ${waveTool}`();

      const secondCall = mockFetch.mock.calls[1];
      const body = JSON.parse(secondCall[1].body);
      const toolNames = (body.tools || []).map((t: any) => t.function.name);
      expect(toolNames).toContain('greetPerson');
      expect(toolNames).toContain('wavePerson');
    });

    it('next chains work multiple levels deep', async () => {
      const instance = createTooledPrompt({ silent: true });

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'First' } }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'Second' } }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ choices: [{ message: { content: 'Third' } }] }),
        });

      const { data, next: next1 } = await instance.prompt`Turn 1`();
      expect(data).toBe('First');

      const { data: d2, next: next2 } = await next1`Turn 2`();
      expect(d2).toBe('Second');

      const { data: d3 } = await next2`Turn 3`();
      expect(d3).toBe('Third');

      // Third call should have full history: 5 messages
      // [user1, asst1, user2, asst2, user3]
      const thirdCall = mockFetch.mock.calls[2];
      const body = JSON.parse(thirdCall[1].body);
      expect(body.messages).toHaveLength(5);
    });

    it('next.return sentinel is available', async () => {
      const instance = createTooledPrompt({ silent: true });
      const { next } = await instance.prompt`Hello`();

      expect(next.return).toBeDefined();
      expect(typeof next.return).toBe('object');
    });
  });

  describe('config tools', () => {
    let originalFetch: typeof globalThis.fetch;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'OK' } }],
        }),
      });
      globalThis.fetch = mockFetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function toolNames(call: any): string[] {
      const body = JSON.parse(call[1].body);
      return (body.tools || []).map((t: any) => t.function.name);
    }

    function cfgGreet(name: string) {
      return `hi ${name}`;
    }
    function cfgFarewell(name: string) {
      return `bye ${name}`;
    }
    function cfgWave() {
      return '*waves*';
    }

    const greet = tool(cfgGreet, { args: [['name', 'Name to greet']] });
    const farewell = tool(cfgFarewell, { args: [['name', 'Name']] });
    const wave = tool(cfgWave);

    it('factory config tools included in API request body', async () => {
      const instance = createTooledPrompt({ tools: [greet], silent: true });
      await instance.prompt`Do something`();

      expect(toolNames(mockFetch.mock.calls[0])).toContain('cfgGreet');
    });

    it('setConfig tools included in API request body', async () => {
      const instance = createTooledPrompt({ silent: true });
      instance.setConfig({ tools: [farewell] });
      await instance.prompt`Do something`();

      expect(toolNames(mockFetch.mock.calls[0])).toContain('cfgFarewell');
    });

    it('per-call config tools included', async () => {
      const instance = createTooledPrompt({ silent: true });
      await instance.prompt`Do something`({ tools: [wave] });

      expect(toolNames(mockFetch.mock.calls[0])).toContain('cfgWave');
    });

    it('config tools merged with template tools (not replacing)', async () => {
      const instance = createTooledPrompt({ tools: [greet], silent: true });
      await instance.prompt`Use ${farewell}`();

      const names = toolNames(mockFetch.mock.calls[0]);
      expect(names).toContain('cfgFarewell'); // template tool
      expect(names).toContain('cfgGreet'); // config tool
    });

    it('setConfig tools override factory tools', async () => {
      const instance = createTooledPrompt({ tools: [greet], silent: true });
      instance.setConfig({ tools: [farewell] });
      await instance.prompt`Do something`();

      const names = toolNames(mockFetch.mock.calls[0]);
      expect(names).toContain('cfgFarewell');
      expect(names).not.toContain('cfgGreet');
    });

    it('per-call tools concatenated with instance tools', async () => {
      const instance = createTooledPrompt({ tools: [greet], silent: true });
      instance.setConfig({ tools: [farewell] });
      await instance.prompt`Do something`({ tools: [wave] });

      const names = toolNames(mockFetch.mock.calls[0]);
      expect(names).toContain('cfgWave'); // per-call
      expect(names).toContain('cfgFarewell'); // instance (replaced greet via setConfig)
      expect(names).not.toContain('cfgGreet'); // overwritten by setConfig
    });

    it('setConfig replaces (not appends) within its layer', async () => {
      const instance = createTooledPrompt({ silent: true });
      instance.setConfig({ tools: [greet] });
      instance.setConfig({ tools: [farewell] });
      await instance.prompt`Do something`();

      const names = toolNames(mockFetch.mock.calls[0]);
      expect(names).toContain('cfgFarewell');
      expect(names).not.toContain('cfgGreet');
    });
  });
});
