/**
 * LLM Execution Runtime
 *
 * Handles prompt building and the LLM tool loop.
 */

import { TOOL_SYMBOL, type ToolFunction, type ResolvedTooledPromptConfig, type ContentPart, type PromptContent, type ResolvedSchema } from './types.js';
import type { TooledPromptEmitter } from './events.js';
import type { Store } from './store.js';
import { isImageMarker } from './image.js';

// ============================================================================
// Prompt Building
// ============================================================================

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

    return result
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  }

  // Image path — build ContentPart[]
  const parts: ContentPart[] = [];
  let textBuffer = '';

  function flushText() {
    if (textBuffer) {
      // Apply same cleanup as the string path
      const cleaned = textBuffer
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n');
      parts.push({ type: 'text', text: cleaned });
      textBuffer = '';
    }
  }

  for (let i = 0; i < strings.length; i++) {
    textBuffer += strings[i];

    if (i < values.length) {
      const value = values[i];

      if (isImageMarker(value)) {
        flushText();
        parts.push({ type: 'image_url', image_url: { url: value.url } });
      } else if (isToolValue(value)) {
        const metadata = value[TOOL_SYMBOL];
        textBuffer += `the "${metadata.name}" tool`;
      } else if (typeof value === 'string') {
        textBuffer += value;
      } else if (value !== undefined && value !== null) {
        textBuffer += String(value);
      }
    }
  }

  flushText();

  // Trim leading/trailing whitespace on first and last text parts
  if (parts.length > 0) {
    const first = parts[0];
    if (first.type === 'text') {
      first.text = first.text.replace(/^\s+/, '');
    }
    const last = parts[parts.length - 1];
    if (last.type === 'text') {
      last.text = last.text.replace(/\s+$/, '');
    }
  }

  return parts;
}

function isToolValue(value: unknown): value is ToolFunction {
  return typeof value === 'function' && TOOL_SYMBOL in value;
}

// ============================================================================
// OpenAI Tool Conversion
// ============================================================================

/**
 * Convert tool functions to OpenAI tool format
 */
export function toolsToOpenAI(tools: ToolFunction[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((tool) => {
    const metadata = tool[TOOL_SYMBOL];
    return {
      type: 'function' as const,
      function: {
        name: metadata.name,
        description: metadata.description,
        parameters: metadata.parameters as Record<string, unknown>,
      },
    };
  });
}

// ============================================================================
// LLM Tool Loop
// ============================================================================

/**
 * Parse SSE stream and yield chunks
 */
async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
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
 */
export async function runToolLoop<T = string>(
  promptText: PromptContent,
  tools: ToolFunction[],
  config: ResolvedTooledPromptConfig,
  emitter: TooledPromptEmitter,
  schema?: ResolvedSchema<T>,
  returnStore?: Store<T>,
): Promise<T> {
  const messages: Array<{
    role: string;
    content: string | ContentPart[] | null;
    tool_calls?: unknown[];
    tool_call_id?: string;
  }> = [{ role: 'user', content: promptText }];

  const openaiTools = toolsToOpenAI(tools);

  // Config is already resolved - use values directly
  const { apiUrl, modelName, apiKey: llmApiKey, maxIterations, stream: useStreaming, timeout } = config;

  let iterations = 0;

  while (maxIterations === undefined || iterations < maxIterations) {
    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: useStreaming,
      ...(config.temperature !== undefined && { temperature: config.temperature }),
    };

    // Include structured output format if schema is provided
    if (schema) {
      body.response_format = {
        type: 'json_object',
        schema: schema.jsonSchema,
        strict: true,
      };
    }

    // Include tools if we have any
    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (llmApiKey) {
      headers['Authorization'] = 'Bearer ' + llmApiKey;
    }

    // Set up timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(apiUrl + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Request timeout after ${timeout}ms`);
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${text}`);
    }

    let content = '';
    let toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];

    if (body.stream && response.body) {
      // Streaming response
      const reader = response.body.getReader();

      for await (const chunk of parseSSEStream(reader)) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle thinking tokens (various provider formats)
        const thinking = delta.thinking || delta.reasoning_content || delta.reasoning;
        if (thinking) {
          emitter.emit('thinking', thinking);
        }

        // Handle regular content
        if (delta.content) {
          emitter.emit('content', delta.content);
          content += delta.content;
        }

        // Handle tool calls (accumulated across chunks)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id || '',
                type: 'function',
                function: { name: tc.function?.name || '', arguments: '' },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].function.name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }

      if (content) {
        emitter.emit('content', '\n');
      }
    } else {
      // Non-streaming response
      const data = (await response.json()) as {
        choices?: Array<{
          message: {
            content?: string;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>;
          };
        }>;
      };
      const choice = data.choices?.[0];

      if (!choice) {
        throw new Error('No response from LLM');
      }

      content = choice.message.content || '';
      toolCalls = choice.message.tool_calls || [];

      if (content) {
        emitter.emit('content', content + '\n');
      }
    }

    // Filter out incomplete tool calls
    toolCalls = toolCalls.filter((tc) => tc.id && tc.function.name);

    // If no tool calls, we're done
    if (toolCalls.length === 0) {
      // If we have a schema, parse and validate the response
      if (schema) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          throw new Error(
            `Failed to parse JSON response: ${(err as Error).message}\n\nRaw content:\n${content}`
          );
        }

        try {
          return schema.parse(parsed) as T;
        } catch (err) {
          throw new Error(
            `Schema validation failed: ${(err as Error).message}\n\nParsed JSON:\n${JSON.stringify(parsed, null, 2)}`
          );
        }
      }

      // No schema - return the content as string
      return content as T;
    }

    // Execute tool calls and collect results
    const toolResults: Array<{
      id: string;
      name: string;
      args: Record<string, unknown>;
      result: string;
    }> = [];

    for (const toolCall of toolCalls) {
      const tool = tools.find((t) => t[TOOL_SYMBOL].name === toolCall.function.name);

      if (!tool) {
        console.warn(`Unknown tool: ${toolCall.function.name}`);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: {},
          result: JSON.stringify({
            error: `Unknown tool: ${toolCall.function.name}`,
          }),
        });
        continue;
      }

      const startTime = Date.now();
      let input: Record<string, unknown>;

      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch (err) {
        const error = `Invalid JSON arguments: ${(err as Error).message}`;
        emitter.emit('tool_error', toolCall.function.name, error);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: {},
          result: JSON.stringify({ error }),
        });
        continue;
      }

      // Emit tool_call event
      emitter.emit('tool_call', toolCall.function.name, input);

      try {
        // Call the tool with its arguments
        const paramNames = Object.keys(tool[TOOL_SYMBOL].parameters.properties || {});
        const args = paramNames.map((name) => input[name]);
        const result = await tool(...args);

        // Handle void/undefined results
        let resultStr: string;
        if (result === undefined || result === null) {
          resultStr = 'OK';
        } else if (typeof result === 'string') {
          resultStr = result;
        } else {
          resultStr = JSON.stringify(result);
        }

        const duration = Date.now() - startTime;
        emitter.emit('tool_result', toolCall.function.name, resultStr, duration);

        toolResults.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: input,
          result: resultStr,
        });
      } catch (err) {
        const error = err as Error;
        const duration = Date.now() - startTime;
        emitter.emit('tool_error', toolCall.function.name, error.message);
        toolResults.push({
          id: toolCall.id,
          name: toolCall.function.name,
          args: input,
          result: JSON.stringify({ error: error.message }),
        });
      }
    }

    // Add assistant response to history
    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls,
    });

    // Add tool results to history
    for (const tr of toolResults) {
      // Truncate long results to avoid context overflow
      const maxResultLength = 2000;
      const truncated =
        tr.result.length > maxResultLength
          ? tr.result.slice(0, maxResultLength) +
            `\n... (truncated, ${tr.result.length} total chars)`
          : tr.result;

      messages.push({
        role: 'tool',
        tool_call_id: tr.id,
        content: truncated,
      });
    }

    // Check if the return store has been filled — early exit
    if (returnStore) {
      const val = returnStore.get();
      if (val !== undefined) return val;
    }

    iterations++;
  }

  // Max iterations reached
  throw new Error(`Max iterations (${maxIterations}) reached without completion`);
}
