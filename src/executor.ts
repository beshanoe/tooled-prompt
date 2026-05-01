/**
 * LLM Execution Runtime
 *
 * Handles prompt building and the LLM tool loop.
 * Delegates provider-specific logic to ProviderAdapter implementations.
 */

import {
  TOOL_SYMBOL,
  type ToolFunction,
  type ToolMetadata,
  type ResolvedTooledPromptConfig,
  type ContentPart,
  type PromptContent,
  type ResolvedSchema,
} from './types.js';
import dedent from 'dedent';
import type { TooledPromptEmitter } from './events.js';
import type { Store } from './store.js';
import { isImageMarker } from './image.js';
import { fileTypeFromBuffer } from 'file-type';
import { getProvider } from './providers/index.js';
import type { ToolResultInfo, Usage } from './providers/types.js';
import { TOOLBOX_SYMBOL, type ToolboxFunction } from './toolbox.js';

// Re-export parseSSEStream for backward compatibility
export { parseSSEStream } from './streaming.js';

// ============================================================================
// Prompt Building
// ============================================================================

function cleanPrompt(text: string): string {
  return dedent(text)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Build the final prompt content from template parts and resolved values.
 * Returns a plain string when no images are present (zero behavior change),
 * or a ContentPart[] array when images exist.
 */
export function buildPromptText(strings: TemplateStringsArray, values: unknown[]): PromptContent {
  // Quick scan for image markers
  let hasImages = false;
  for (let i = 0; i < values.length; i++) {
    if (isImageMarker(values[i])) {
      hasImages = true;
      break;
    }
  }

  if (!hasImages) {
    // Original string path — unchanged behavior
    let result = '';

    for (let i = 0; i < strings.length; i++) {
      result += strings[i];

      if (i < values.length) {
        const value = values[i];

        if (isToolValue(value)) {
          const metadata = value[TOOL_SYMBOL];
          result += `the "${metadata.name}" tool`;
          continue;
        }

        if (typeof value === 'string') {
          result += value;
        } else if (value !== undefined && value !== null) {
          result += String(value);
        }
      }
    }

    return cleanPrompt(result);
  }

  // Image path — build ContentPart[]
  const images: ContentPart[] = [];
  let text = '';
  let imageIndex = 0;

  for (let i = 0; i < strings.length; i++) {
    text += strings[i];

    if (i < values.length) {
      const value = values[i];

      if (isImageMarker(value)) {
        imageIndex++;
        text += `image_${imageIndex}`;
        images.push({ type: 'image_url', image_url: { url: value.url } });
      } else if (isToolValue(value)) {
        text += `the "${value[TOOL_SYMBOL].name}" tool`;
      } else if (typeof value === 'string') {
        text += value;
      } else if (value !== undefined && value !== null) {
        text += String(value);
      }
    }
  }

  return [{ type: 'text', text: cleanPrompt(text) }, ...images];
}

function isToolValue(value: unknown): value is ToolFunction {
  return typeof value === 'function' && TOOL_SYMBOL in value;
}

// ============================================================================
// Iterable Resolution
// ============================================================================

/**
 * If a tool returns an async/sync iterable (e.g. Deno's readDir()),
 * collect all items into an array so the result can be JSON-stringified.
 * Strings and arrays pass through unchanged.
 */
async function resolveIterableResult(result: unknown): Promise<unknown> {
  if (result == null || typeof result === 'string' || Array.isArray(result)) {
    return result;
  }
  if (typeof result === 'object' && Symbol.asyncIterator in (result as object)) {
    const items: unknown[] = [];
    for await (const item of result as AsyncIterable<unknown>) {
      items.push(item);
    }
    return items;
  }
  if (typeof result === 'object' && Symbol.iterator in (result as object)) {
    return Array.from(result as Iterable<unknown>);
  }
  return result;
}

// ============================================================================
// LLM Tool Loop
// ============================================================================

/**
 * Run the LLM tool loop until completion or max iterations.
 *
 * When schema is provided, returns T directly (throws on error).
 * When no schema, returns string message (throws on error).
 *
 * @param promptText - The prompt text to send to the LLM
 * @param tools - Array of tool functions available to the LLM
 * @param config - Resolved configuration (all values already merged)
 * @param emitter - Event emitter for streaming events
 * @param schema - Optional resolved schema for structured output
 * @param returnStore - Optional return store; when filled, the tool loop exits early
 * @param systemPrompt - Optional processed system prompt text
 * @param systemImages - Optional images extracted from system prompt
 * @param history - Optional previous conversation messages to prepend
 */
export async function runToolLoop<T = string>(
  promptText: PromptContent,
  tools: ToolFunction[],
  config: ResolvedTooledPromptConfig,
  emitter: TooledPromptEmitter,
  schema?: ResolvedSchema<T>,
  returnStore?: Store<T>,
  systemPrompt?: PromptContent,
  systemImages?: ContentPart[],
  history?: unknown[],
): Promise<{ result: T; messages: unknown[]; usage?: Usage }> {
  emitter.emit('start');
  const provider = getProvider(config.provider);
  const toolMeta: ToolMetadata[] = tools.map((t) => t[TOOL_SYMBOL]);

  // Build messages: prepend history, then add new user message
  const messages: unknown[] = [...(history || []), provider.formatUserMessage(promptText, systemImages)];

  // Config is already resolved - use values directly
  const { apiUrl, modelName, apiKey, maxIterations, stream: useStreaming, timeout } = config;

  let iterations = 0;
  let usage: Usage | undefined;

  while (maxIterations === undefined || iterations < maxIterations) {
    const { url, headers, body } = provider.buildRequest({
      apiUrl,
      apiKey,
      modelName,
      messages,
      tools: toolMeta,
      stream: useStreaming,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      systemPrompt,
      schema: schema ? { jsonSchema: schema.jsonSchema } : undefined,
    });

    // Set up timeout with AbortController.
    // The timer must stay armed through body consumption: aborting the fetch
    // signal alone does not reliably terminate an already-opened response
    // body stream, so when it fires we also call body.cancel() to force the
    // ReadableStream closed.
    const controller = new AbortController();
    let response: Response | undefined;
    const timeoutId = setTimeout(() => {
      controller.abort();
      response?.body?.cancel().catch(() => {});
    }, timeout);

    let parsed: Awaited<ReturnType<typeof provider.parseResponse>>;
    try {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`Request timeout after ${timeout}ms`);
        }
        throw err;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${text}`);
      }

      try {
        parsed = await provider.parseResponse(response, useStreaming, emitter, config.streamChunkTimeoutMs);
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
          throw new Error(`Request timeout after ${timeout}ms`);
        }
        throw err;
      }
      // If the timer fired during body reading, body.cancel() closed the
      // stream cleanly and parseResponse returned partial content. That's
      // still a timeout from the caller's perspective.
      if (controller.signal.aborted) {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
    const { content, toolCalls: rawToolCalls } = parsed;

    if (parsed.usage) {
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + parsed.usage.promptTokens,
        completionTokens: (usage?.completionTokens ?? 0) + parsed.usage.completionTokens,
        totalTokens: (usage?.totalTokens ?? 0) + parsed.usage.totalTokens,
      };
    }

    // Filter out incomplete tool calls
    const toolCalls = rawToolCalls.filter((tc) => tc.id && tc.name);

    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      // Add final assistant message to history
      messages.push(provider.formatAssistantMessage(content, []));

      // If we have a schema, parse and validate the response
      if (schema) {
        let parsedContent: unknown;
        try {
          parsedContent = JSON.parse(content);
        } catch (err) {
          throw new Error(`Failed to parse JSON response: ${(err as Error).message}\n\nRaw content:\n${content}`);
        }

        try {
          return { result: schema.parse(parsedContent) as T, messages, usage };
        } catch (err) {
          throw new Error(
            `Schema validation failed: ${(err as Error).message}\n\nParsed JSON:\n${JSON.stringify(parsedContent, null, 2)}`,
          );
        }
      }

      // No schema - return the content as string
      return { result: content as T, messages, usage };
    }

    // Execute tool calls and collect results
    const toolResults: ToolResultInfo[] = [];

    for (const toolCall of toolCalls) {
      const toolFn = tools.find((t) => t[TOOL_SYMBOL].name === toolCall.name);

      if (!toolFn) {
        console.warn(`Unknown tool: ${toolCall.name}`);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: JSON.stringify({
            error: `Unknown tool: ${toolCall.name}`,
          }),
        });
        continue;
      }

      const startTime = Date.now();
      let input: Record<string, unknown>;

      try {
        input = JSON.parse(toolCall.arguments);
      } catch (err) {
        const error = `Invalid JSON arguments: ${(err as Error).message}`;
        emitter.emit('tool_error', toolCall.name, error);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: JSON.stringify({ error }),
        });
        continue;
      }

      // Emit tool_call event
      emitter.emit('tool_call', toolCall.name, input);

      try {
        // Call the tool with its arguments
        const paramNames = Object.keys(toolFn[TOOL_SYMBOL].parameters.properties || {});
        const args = paramNames.map((name) => input[name]);
        const rawResult = await toolFn(...args);

        // Handle void/undefined results
        let resultStr: string;
        let images: string[] | undefined;

        if (rawResult instanceof Uint8Array) {
          // Image buffer returned from tool — convert to data URL
          const ft = await fileTypeFromBuffer(rawResult);
          const mime = ft?.mime ?? 'application/octet-stream';
          const base64 = Buffer.from(rawResult).toString('base64');
          images = [`data:${mime};base64,${base64}`];
          resultStr = '[image]';
        } else {
          let result = await resolveIterableResult(rawResult);
          const { parseReturn } = toolFn[TOOL_SYMBOL];
          if (parseReturn) {
            result = parseReturn(result);
          }

          if (result === undefined || result === null) {
            resultStr = 'OK';
          } else if (typeof result === 'string') {
            resultStr = result;
          } else {
            resultStr = JSON.stringify(result);
          }
        }

        const duration = Date.now() - startTime;
        emitter.emit('tool_result', toolCall.name, resultStr, duration);

        // Truncate long results when maxToolResultLength is configured
        const truncated =
          config.maxToolResultLength && resultStr.length > config.maxToolResultLength
            ? resultStr.slice(0, config.maxToolResultLength) + `\n... (truncated, ${resultStr.length} total chars)`
            : resultStr;

        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: truncated,
          images,
        });
      } catch (err) {
        const error = err as Error;
        emitter.emit('tool_error', toolCall.name, error.message);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.name,
          result: JSON.stringify({ error: error.message }),
        });
      }
    }

    // Toolbox expansion: drain pending tools from any toolbox meta-tools
    for (const toolFn of tools) {
      if (TOOLBOX_SYMBOL in toolFn) {
        const box = (toolFn as ToolboxFunction)[TOOLBOX_SYMBOL];
        if (box.pending.length > 0) {
          const existingNames = new Set(tools.map((t) => t[TOOL_SYMBOL].name));
          const newTools = box.pending.filter((t) => !existingNames.has(t[TOOL_SYMBOL].name));
          tools.push(...newTools);
          // Rebuild toolMeta in-place
          toolMeta.length = 0;
          toolMeta.push(...tools.map((t) => t[TOOL_SYMBOL]));
          box.pending.length = 0;
        }
      }
    }

    // Build history using provider formatting
    messages.push(provider.formatAssistantMessage(content, toolCalls));
    messages.push(...provider.formatToolResults(toolResults));

    // Check if the return store has been filled — early exit
    if (returnStore) {
      const val = returnStore.get();
      if (val !== undefined) return { result: val, messages, usage };
    }

    iterations++;
  }

  // Max iterations reached
  throw new Error(`Max iterations (${maxIterations}) reached without completion`);
}
