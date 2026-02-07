import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTooledPrompt } from '../factory.js';

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
        llmUrl: 'https://custom.api.com/v1',
        apiKey: 'test-key',
      });
      expect(instance).toBeDefined();
    });
  });

  describe('config validation', () => {
    it('throws on invalid temperature (too low)', () => {
      expect(() =>
        createTooledPrompt({ temperature: -0.1 })
      ).toThrow('temperature must be between 0 and 2');
    });

    it('throws on invalid temperature (too high)', () => {
      expect(() =>
        createTooledPrompt({ temperature: 2.5 })
      ).toThrow('temperature must be between 0 and 2');
    });

    it('throws on invalid maxIterations (zero)', () => {
      expect(() =>
        createTooledPrompt({ maxIterations: 0 })
      ).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid maxIterations (negative)', () => {
      expect(() =>
        createTooledPrompt({ maxIterations: -5 })
      ).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid maxIterations (float)', () => {
      expect(() =>
        createTooledPrompt({ maxIterations: 5.5 })
      ).toThrow('maxIterations must be a positive integer');
    });

    it('throws on invalid timeout (negative)', () => {
      expect(() =>
        createTooledPrompt({ timeout: -1000 })
      ).toThrow('timeout must be a positive number');
    });

    it('throws on invalid timeout (Infinity)', () => {
      expect(() =>
        createTooledPrompt({ timeout: Infinity })
      ).toThrow('timeout must be a positive number');
    });

    it('accepts valid config values', () => {
      expect(() =>
        createTooledPrompt({
          temperature: 0,
          maxIterations: 1,
          timeout: 0,
        })
      ).not.toThrow();

      expect(() =>
        createTooledPrompt({
          temperature: 2,
          maxIterations: 100,
          timeout: 300000,
        })
      ).not.toThrow();
    });
  });

  describe('setConfig validation', () => {
    it('validates config on setConfig', () => {
      const instance = createTooledPrompt();
      expect(() => instance.setConfig({ temperature: 3 })).toThrow(
        'temperature must be between 0 and 2'
      );
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

    it('uses llmUrl in fetch request', async () => {
      const instance = createTooledPrompt({
        llmUrl: 'https://test-api.example.com/v1',
        silent: true,
      });

      await instance.prompt`Test`();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://test-api.example.com/v1/chat/completions',
        expect.any(Object)
      );
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
        })
      );
    });

    it('uses llmModel in request body', async () => {
      const instance = createTooledPrompt({
        llmModel: 'gpt-4-turbo',
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
        llmModel: 'initial-model',
        silent: true,
      });

      // First request
      await instance.prompt`First`();
      let body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('initial-model');

      // Update config
      instance.setConfig({ llmModel: 'updated-model', temperature: 0.9 });

      // Second request
      await instance.prompt`Second`();
      body = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body.model).toBe('updated-model');
      expect(body.temperature).toBe(0.9);
    });

    it('per-call config overrides instance config', async () => {
      const instance = createTooledPrompt({
        llmModel: 'instance-model',
        temperature: 0.5,
        silent: true,
      });

      await instance.prompt`Test`({ llmModel: 'call-model', temperature: 0.9 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('call-model');
      expect(body.temperature).toBe(0.9);
    });
  });
});
