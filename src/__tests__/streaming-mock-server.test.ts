/**
 * End-to-end streaming tests against a real mock OpenAI-compatible server
 * (scripts/mock-openai.mjs). Exercises the streamChunkTimeoutMs knob over an
 * actual TCP/SSE stream — covers stalls, slow first tokens, and successful
 * runs that the pure-mock unit tests can't reach.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runToolLoop } from '../executor.js';
import type { ResolvedTooledPromptConfig } from '../types.js';
import { TooledPromptEmitter } from '../events.js';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/mock-openai.mjs');

let server: ChildProcess;
let baseUrl: string;

function startServer(): Promise<{ proc: ChildProcess; baseUrl: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let settled = false;

    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/MOCK_OPENAI_PORT=(\d+)/);
      if (match && !settled) {
        settled = true;
        proc.stdout?.off('data', onData);
        resolvePromise({ proc, baseUrl: `http://localhost:${match[1]}/v1` });
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', (d) => {
      if (process.env.DEBUG_MOCK) process.stderr.write(d);
    });
    proc.once('exit', (code) => {
      if (!settled) {
        settled = true;
        rejectPromise(new Error(`mock server exited before listening (code=${code}); buf=${buf}`));
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGKILL');
        rejectPromise(new Error(`mock server did not announce port within 5s; buf=${buf}`));
      }
    }, 5000).unref?.();
  });
}

function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    if (proc.exitCode !== null) return resolvePromise();
    proc.once('exit', () => resolvePromise());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 1000).unref?.();
  });
}

function makeConfig(overrides: Partial<ResolvedTooledPromptConfig> = {}): ResolvedTooledPromptConfig {
  return {
    apiUrl: baseUrl,
    modelName: 'mock',
    apiKey: 'test',
    maxIterations: 1,
    temperature: undefined,
    stream: true,
    timeout: 30_000,
    silent: true,
    showThinking: false,
    provider: 'openai',
    maxTokens: undefined,
    systemPrompt: undefined,
    maxToolResultLength: undefined,
    streamChunkTimeoutMs: undefined,
    ...overrides,
  };
}

beforeAll(async () => {
  const started = await startServer();
  server = started.proc;
  baseUrl = started.baseUrl;
}, 10_000);

afterAll(async () => {
  if (server) await stopServer(server);
});

describe('streaming against mock OpenAI server', () => {
  it('completes a normal streaming response', async () => {
    const emitter = new TooledPromptEmitter();
    const chunks: string[] = [];
    emitter.on('content', (s: string) => chunks.push(s));

    const config = makeConfig({
      modelName: 'mock:normal|chunks=4&gapMs=20&text=hello%20world',
    });

    const { result } = await runToolLoop('say hi', [], config, emitter);
    expect(result).toContain('hello world');
    expect(chunks.join('')).toContain('hello world');
  }, 10_000);

  it('rejects with chunk-timeout error when server stalls mid-stream', async () => {
    const emitter = new TooledPromptEmitter();
    const config = makeConfig({
      modelName: 'mock:stall',
      streamChunkTimeoutMs: 400,
    });

    const t0 = Date.now();
    await expect(runToolLoop('stall me', [], config, emitter)).rejects.toThrow(/SSE chunk timeout after 400ms/);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3_000);
  }, 10_000);

  it('rejects when first-token delay exceeds streamChunkTimeoutMs', async () => {
    const emitter = new TooledPromptEmitter();
    const config = makeConfig({
      modelName: 'mock:slow_first|firstTokenDelayMs=1500&chunks=2&gapMs=10',
      streamChunkTimeoutMs: 300,
    });

    await expect(runToolLoop('slow', [], config, emitter)).rejects.toThrow(/SSE chunk timeout after 300ms/);
  }, 10_000);

  it('succeeds with a generous streamChunkTimeoutMs even when first token is delayed', async () => {
    const emitter = new TooledPromptEmitter();
    const config = makeConfig({
      modelName: 'mock:slow_first|firstTokenDelayMs=600&chunks=2&gapMs=10&text=ok',
      streamChunkTimeoutMs: 5_000,
    });

    const { result } = await runToolLoop('slow ok', [], config, emitter);
    expect(result).toContain('ok');
  }, 10_000);
});
