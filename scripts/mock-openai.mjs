#!/usr/bin/env node
/**
 * Mock OpenAI-compatible /v1/chat/completions server for stress-testing
 * streaming behavior in tooled-prompt (or any OpenAI client).
 *
 * Run:   node scripts/mock-openai.mjs
 * Base:  http://localhost:8787/v1
 *
 * Drive behavior via query params on the request URL OR via the `model`
 * field in the request body. Either works; query params win.
 *
 *   ?scenario=normal          stream a short reply, end cleanly
 *   ?scenario=slow_first      wait `firstTokenDelayMs` before the first chunk
 *   ?scenario=stall           send one chunk, then go silent forever
 *   ?scenario=mid_stream_kill send a few chunks, then destroy the socket
 *   ?scenario=no_done         send chunks and close without `data: [DONE]`
 *   ?scenario=tool_call       stream a tool_call across multiple deltas
 *   ?scenario=garbage         send malformed SSE lines mixed with valid ones
 *
 * Tunables (all optional, milliseconds):
 *   ?firstTokenDelayMs=20000   gap before the first SSE chunk
 *   ?gapMs=200                 gap between subsequent chunks
 *   ?stallAfterMs=500          for mid_stream_kill: when to drop the socket
 *   ?chunks=8                  how many content deltas to send
 *   ?text=hello                text to stream (split into N chunks)
 *
 * Examples:
 *   curl -N http://localhost:8787/v1/chat/completions?scenario=stall \
 *     -H 'content-type: application/json' \
 *     -d '{"model":"x","messages":[{"role":"user","content":"hi"}],"stream":true}'
 *
 * Point tooled-prompt at it:
 *   createTooledPrompt({
 *     apiUrl: 'http://localhost:8787/v1',
 *     modelName: 'mock',
 *     apiKey: 'test',
 *     streamChunkTimeoutMs: 1_000,
 *   });
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function deltaChunk({ id, model, content, toolCall, finishReason }) {
  const choice = { index: 0, delta: {}, finish_reason: finishReason ?? null };
  if (content !== undefined) choice.delta.content = content;
  if (toolCall) choice.delta.tool_calls = [toolCall];
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
  };
}

function usageChunk({ id, model }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function splitInto(text, n) {
  if (n <= 1) return [text];
  const size = Math.max(1, Math.ceil(text.length / n));
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function resolveScenario(req, body) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  const fromModel = typeof body?.model === 'string' && body.model.startsWith('mock:') ? body.model.slice(5) : '';
  const fromModelParts = fromModel.split('|');
  const params = new URLSearchParams(fromModelParts.slice(1).join('&'));
  return {
    scenario: q.get('scenario') ?? params.get('scenario') ?? fromModelParts[0] ?? 'normal',
    firstTokenDelayMs: Number(q.get('firstTokenDelayMs') ?? params.get('firstTokenDelayMs') ?? 0),
    gapMs: Number(q.get('gapMs') ?? params.get('gapMs') ?? 50),
    stallAfterMs: Number(q.get('stallAfterMs') ?? params.get('stallAfterMs') ?? 300),
    chunks: Number(q.get('chunks') ?? params.get('chunks') ?? 5),
    text: q.get('text') ?? params.get('text') ?? 'Hello from the mock server. ',
  };
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'bad_json' }));
    return;
  }

  const opts = resolveScenario(req, body);
  const id = `chatcmpl-${randomUUID()}`;
  const model = body?.model ?? 'mock';
  const streaming = body?.stream === true;

  console.log(`[${new Date().toISOString()}] ${opts.scenario} streaming=${streaming} opts=`, opts);

  if (!streaming) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: opts.text },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    );
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  // Flush headers before any sleep so the client's fetch() resolves and starts
  // reading the body. Without this, Node buffers headers until the first write,
  // which masks per-chunk stalls behind a longer "waiting for headers" phase.
  res.flushHeaders?.();

  const write = (frame) =>
    new Promise((resolve) => {
      const ok = res.write(frame);
      if (ok) resolve();
      else res.once('drain', resolve);
    });

  // Drop client disconnects so unhandled errors don't crash the server.
  req.on('close', () => res.destroyed || res.destroy());

  try {
    if (opts.firstTokenDelayMs > 0) await sleep(opts.firstTokenDelayMs);

    switch (opts.scenario) {
      case 'normal': {
        for (const piece of splitInto(opts.text, opts.chunks)) {
          await write(sseFrame(deltaChunk({ id, model, content: piece })));
          await sleep(opts.gapMs);
        }
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'stop' })));
        await write(sseFrame(usageChunk({ id, model })));
        await write('data: [DONE]\n\n');
        break;
      }

      case 'slow_first': {
        // firstTokenDelayMs already applied above.
        for (const piece of splitInto(opts.text, opts.chunks)) {
          await write(sseFrame(deltaChunk({ id, model, content: piece })));
          await sleep(opts.gapMs);
        }
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'stop' })));
        await write(sseFrame(usageChunk({ id, model })));
        await write('data: [DONE]\n\n');
        break;
      }

      case 'stall': {
        await write(sseFrame(deltaChunk({ id, model, content: 'partial...' })));
        // Park forever — client must enforce its own per-chunk deadline.
        await new Promise(() => {});
        break;
      }

      case 'mid_stream_kill': {
        const start = Date.now();
        for (const piece of splitInto(opts.text, opts.chunks)) {
          await write(sseFrame(deltaChunk({ id, model, content: piece })));
          await sleep(opts.gapMs);
          if (Date.now() - start > opts.stallAfterMs) break;
        }
        // Hard close, no [DONE].
        req.socket.destroy();
        break;
      }

      case 'no_done': {
        for (const piece of splitInto(opts.text, opts.chunks)) {
          await write(sseFrame(deltaChunk({ id, model, content: piece })));
          await sleep(opts.gapMs);
        }
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'stop' })));
        // End response cleanly but without [DONE]
        res.end();
        break;
      }

      case 'tool_call': {
        const callId = `call_${randomUUID().slice(0, 8)}`;
        await write(
          sseFrame(
            deltaChunk({
              id,
              model,
              toolCall: {
                index: 0,
                id: callId,
                type: 'function',
                function: { name: 'lookup', arguments: '' },
              },
            }),
          ),
        );
        for (const piece of splitInto('{"q":"weather in NYC"}', opts.chunks)) {
          await sleep(opts.gapMs);
          await write(
            sseFrame(
              deltaChunk({
                id,
                model,
                toolCall: { index: 0, function: { arguments: piece } },
              }),
            ),
          );
        }
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'tool_calls' })));
        await write(sseFrame(usageChunk({ id, model })));
        await write('data: [DONE]\n\n');
        break;
      }

      case 'garbage': {
        await write('event: ping\ndata: \n\n');
        await write('data: not-json\n\n');
        await write(': comment line\n\n');
        await sleep(opts.gapMs);
        for (const piece of splitInto(opts.text, opts.chunks)) {
          await write(sseFrame(deltaChunk({ id, model, content: piece })));
          await sleep(opts.gapMs);
        }
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'stop' })));
        await write('data: [DONE]\n\n');
        break;
      }

      default: {
        await write(sseFrame(deltaChunk({ id, model, content: `unknown scenario: ${opts.scenario}` })));
        await write(sseFrame(deltaChunk({ id, model, finishReason: 'stop' })));
        await write('data: [DONE]\n\n');
      }
    }
  } catch (err) {
    if (!res.destroyed) {
      try {
        res.end();
      } catch {}
    }
    console.error('handler error:', err);
  }

  if (!res.writableEnded) res.end();
});

server.listen(PORT, () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  // Machine-parseable line for test harnesses that spawn this script.
  console.log(`MOCK_OPENAI_PORT=${port}`);
  console.log(`mock OpenAI server listening on http://localhost:${port}/v1`);
});
