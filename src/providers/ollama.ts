/**
 * Ollama native provider adapter
 *
 * Handles Ollama's /api/chat endpoint for request building,
 * response parsing (NDJSON streaming), and message formatting.
 */

import type { ContentPart, PromptContent } from '../types.js';
import type { TooledPromptEmitter } from '../events.js';
import type {
  ProviderAdapter,
  ToolCallInfo,
  ToolResultInfo,
  ParsedResponse,
  BuildRequestParams,
  BuildRequestResult,
} from './types.js';
import { parseDataUrl, toolsToOpenAIFormat } from './utils.js';

type OllamaToolCall = { function: { name: string; arguments: string | Record<string, unknown> } };

interface OllamaResponseMessage {
  content?: string;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }>;
}

interface OllamaStreamChunk {
  done?: boolean;
  message?: OllamaResponseMessage;
}

interface OllamaResponse {
  message?: OllamaResponseMessage;
}

export type OllamaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string };

function extractBase64Images(parts: ContentPart[]): string[] {
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === 'image_url') {
      try {
        const { base64 } = parseDataUrl(part.image_url.url);
        images.push(base64);
      } catch {
        // Skip non-data URLs
      }
    }
  }
  return images;
}

function extractText(content: PromptContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export class OllamaProvider implements ProviderAdapter<OllamaMessage> {
  buildRequest(params: BuildRequestParams): BuildRequestResult {
    const url = params.apiUrl + '/api/chat';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const messages = [...params.messages];

    // Prepend system message if provided
    if (params.systemPrompt !== undefined) {
      messages.unshift({ role: 'system', content: extractText(params.systemPrompt) });
    }

    const body: Record<string, unknown> = {
      model: params.modelName,
      messages,
      stream: params.stream,
      ...(params.temperature !== undefined && { options: { temperature: params.temperature } }),
    };

    // Structured output: Ollama uses `format` field with JSON schema directly
    if (params.schema) {
      body.format = params.schema.jsonSchema;
    }

    // Tools in OpenAI format (Ollama uses same format)
    const openaiTools = toolsToOpenAIFormat(params.tools);
    if (openaiTools.length > 0) {
      body.tools = openaiTools;
    }

    return { url, headers, body };
  }

  formatUserMessage(content: PromptContent, prependImages?: ContentPart[]): OllamaMessage {
    const text = extractText(content);
    const images: string[] = [];

    // Collect images from prepended system images
    if (prependImages) {
      images.push(...extractBase64Images(prependImages));
    }

    // Collect images from content parts
    if (Array.isArray(content)) {
      images.push(...extractBase64Images(content));
    }

    if (images.length > 0) {
      return { role: 'user', content: text, images };
    }
    return { role: 'user', content: text };
  }

  formatAssistantMessage(content: string, toolCalls: ToolCallInfo[]): OllamaMessage {
    return {
      role: 'assistant',
      content: content || '',
      tool_calls:
        toolCalls.length > 0
          ? toolCalls.map((tc): OllamaToolCall => {
              let args: string | Record<string, unknown>;
              try {
                args = JSON.parse(tc.arguments);
              } catch {
                args = {};
              }
              return {
                function: { name: tc.name, arguments: args },
              };
            })
          : undefined,
    };
  }

  formatToolResults(results: ToolResultInfo[]): OllamaMessage[] {
    return results.map((tr) => ({
      role: 'tool',
      content: tr.result,
    }));
  }

  async parseResponse(response: Response, streaming: boolean, emitter: TooledPromptEmitter): Promise<ParsedResponse> {
    let content = '';
    const toolCalls: ToolCallInfo[] = [];

    if (streaming && response.body) {
      // Ollama uses NDJSON (newline-delimited JSON), not SSE
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          let parsed: OllamaStreamChunk;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          const message = parsed.message;
          if (message?.content) {
            emitter.emit('content', message.content);
            content += message.content;
          }

          if (message?.tool_calls) {
            for (const tc of message.tool_calls) {
              toolCalls.push({
                id: `ollama_${toolCalls.length}`,
                name: tc.function?.name || '',
                arguments:
                  typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments
                    : JSON.stringify(tc.function?.arguments || {}),
              });
            }
          }

          if (parsed.done) break;
        }
      }

      if (content) {
        emitter.emit('content', '\n');
      }
    } else {
      // Non-streaming response
      const data = (await response.json()) as OllamaResponse;

      if (!data.message) {
        throw new Error('No response from LLM');
      }

      content = data.message.content || '';

      if (data.message.tool_calls) {
        for (const tc of data.message.tool_calls) {
          toolCalls.push({
            id: `ollama_${toolCalls.length}`,
            name: tc.function?.name || '',
            arguments:
              typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {}),
          });
        }
      }

      if (content) {
        emitter.emit('content', content + '\n');
      }
    }

    return { content, toolCalls };
  }
}
