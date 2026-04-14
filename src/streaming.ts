/**
 * Shared streaming utilities used by provider adapters
 */

/**
 * Parse SSE stream and yield chunks.
 * Shared utility used by OpenAI and Anthropic providers.
 *
 * `chunkTimeoutMs` guards against servers that open a response body but then
 * stall — with no deadline, `reader.read()` would await forever.
 */
export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs = 30_000,
): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunkDeadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SSE chunk timeout after ${chunkTimeoutMs}ms`)), chunkTimeoutMs);
      timer.unref?.();
    });

    let result: { done: boolean; value?: Uint8Array };
    try {
      result = await Promise.race([reader.read(), chunkDeadline]);
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    const { done, value } = result;
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }
}
