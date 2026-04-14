/**
 * Repro for the streaming-timeout bug.
 *
 * Runs a prompt that causes a reasoning-capable local model to stream for a
 * long time, with a short per-call `timeout`. Logs wall-time vs. the
 * configured timeout so the asymmetry is obvious.
 *
 * Pre-fix: the script keeps printing tokens for far longer than `timeout` —
 * the 60 s per-request AbortController deadline in runToolLoop never fires
 * against the body stream.
 *
 * Post-fix: the call rejects at ~`timeout` ms with "Request timeout after
 * Xms", stdout stops immediately, LLM server CPU drops.
 *
 * Usage:
 *   # Any OpenAI-compatible endpoint that streams tokens slowly works.
 *   # Easiest: Ollama with a reasoning model (qwq, deepseek-r1, gpt-oss, ...).
 *   TOOLED_PROMPT_URL=http://localhost:11434/v1 \
 *   TOOLED_PROMPT_PROVIDER=openai \
 *   TOOLED_PROMPT_MODEL=qwq \
 *   TOOLED_PROMPT_STREAM=true \
 *   TOOLED_PROMPT_SHOW_THINKING=true \
 *   tsx examples/timeout-stuck-stream.ts
 */

import './env.js';
import { prompt } from '../src/index.js';

const TIMEOUT_MS = Number(process.env.REPRO_TIMEOUT_MS ?? 5000);

const t0 = Date.now();
const elapsed = () => Date.now() - t0;

process.on('exit', () => {
  console.error(`\n[tp-debug] process exit wall=${elapsed()}ms configured-timeout=${TIMEOUT_MS}ms`);
});

try {
  const { result } = await prompt`
    Enumerate every prime number under 10000, one at a time.
    For EACH prime, show a short reasoning step explaining why the number is
    prime. Do not summarize or skip. Continue until you have covered every
    prime up to 10000.
  `({ timeout: TIMEOUT_MS });
  console.error(`\n[tp-debug] status=resolved wall=${elapsed()}ms result-length=${String(result).length}`);
} catch (err) {
  const e = err as Error;
  console.error(`\n[tp-debug] status=rejected wall=${elapsed()}ms name=${e.name} message=${e.message}`);
  process.exitCode = 1;
}
