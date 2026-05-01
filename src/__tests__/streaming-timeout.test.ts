import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runToolLoop } from '../executor.js';
import type { ResolvedTooledPromptConfig } from '../types.js';
import { TooledPromptEmitter } from '../events.js';

describe('streaming timeout', () => {
  let originalFetch: typeof globalThis.fetch;
  let emitter: TooledPromptEmitter;
  let baseConfig: ResolvedTooledPromptConfig;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    emitter = new TooledPromptEmitter();
    baseConfig = {
      apiUrl: 'http://localhost:8080/v1',
      modelName: 'test-model',
      apiKey: 'test-key',
      maxIterations: undefined,
      temperature: undefined,
      stream: true,
      timeout: 300,
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
    globalThis.fetch = originalFetch;
  });

  /**
   * Build a Response whose headers arrive immediately (fetch resolves fast)
   * but whose body emits one SSE chunk and then hangs forever. Honors
   * reader.cancel()/body.cancel() by resolving the read with {done:true}.
   */
  function buildStuckResponse(signal?: AbortSignal): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
        const onAbort = () => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        signal?.addEventListener('abort', onAbort);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('rejects a stuck streaming response within the configured timeout', async () => {
    const mockFetch = vi.fn(async (_url: string, options: { signal?: AbortSignal }) =>
      buildStuckResponse(options?.signal),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const config = { ...baseConfig, timeout: 300 };
    const t0 = Date.now();

    await expect(runToolLoop('Test stuck stream', [], config, emitter)).rejects.toThrow(/timeout/i);

    const elapsed = Date.now() - t0;
    // Should not wait much longer than the configured timeout.
    expect(elapsed).toBeLessThan(config.timeout * 4);
  }, 5000);

  it('still rejects when fetch itself never returns (pre-header abort)', async () => {
    const mockFetch = vi.fn(
      (_url: string, options: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const config = { ...baseConfig, timeout: 200 };
    await expect(runToolLoop('Test pre-header', [], config, emitter)).rejects.toThrow(/timeout/i);
  }, 5000);
});
