/**
 * OpenAI-compatible provider adapter
 *
 * Handles OpenAI API format for request building, response parsing,
 * and message formatting. Used as the default provider.
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
import { parseSSEStream } from '../streaming.js';
import { toolsToOpenAIFormat, enforceAdditionalProperties } from './utils.js';

type OpenAIToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type OpenAIMessage =
  | { role: 'system'; content: PromptContent }
  | { role: 'user'; content: PromptContent }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export class OpenAIProvider implements ProviderAdapter<OpenAIMessage> {
  buildRequest(params: BuildRequestParams): BuildRequestResult {
    const url = params.apiUrl + '/chat/completions';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (params.apiKey) {
      headers['Authorization'] = 'Bearer ' + params.apiKey;
    }

    const messages = [...params.messages];

    // Prepend system message if provided
    if (params.systemPrompt !== undefined) {
      messages.unshift({ role: 'system', content: params.systemPrompt });
    }

    const body: Record<string, unknown> = {
      model: params.modelName,
      messages,
      stream: params.stream,
      ...(params.temperature !== undefined && { temperature: params.temperature }),
      ...(params.maxTokens !== undefined && { max_tokens: params.maxTokens }),
    };

    if (params.schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'response',
          strict: true,
          schema: enforceAdditionalProperties(params.schema.jsonSchema),
        },
      };
    }

    const openaiTools = toolsToOpenAIFormat(params.tools);
    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    return { url, headers, body };
  }

  formatUserMessage(content: PromptContent, prependImages?: ContentPart[]): OpenAIMessage {
    if (prependImages && prependImages.length > 0) {
      // Convert content to array form if needed and prepend images
      const contentParts: ContentPart[] = [...prependImages];
      if (typeof content === 'string') {
        contentParts.push({ type: 'text', text: content });
      } else {
        contentParts.push(...content);
      }
      return { role: 'user', content: contentParts };
    }
    return { role: 'user', content };
  }

  formatAssistantMessage(content: string, toolCalls: ToolCallInfo[]): OpenAIMessage {
    return {
      role: 'assistant',
      content: content || null,
      tool_calls:
        toolCalls.length > 0
          ? toolCalls.map(
              (tc): OpenAIToolCall => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              }),
            )
          : undefined,
    };
  }

  formatToolResults(results: ToolResultInfo[]): OpenAIMessage[] {
    return results.map((tr) => ({
      role: 'tool',
      tool_call_id: tr.id,
      content: tr.result,
    }));
  }

  async parseResponse(response: Response, streaming: boolean, emitter: TooledPromptEmitter): Promise<ParsedResponse> {
    let content = '';
    let toolCalls: ToolCallInfo[] = [];

    if (streaming && response.body) {
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
                name: tc.function?.name || '',
                arguments: '',
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) toolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[idx].arguments += tc.function.arguments;
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
      toolCalls = (choice.message.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      if (content) {
        emitter.emit('content', content + '\n');
      }
    }

    return { content, toolCalls };
  }
}
