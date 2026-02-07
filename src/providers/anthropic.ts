/**
 * Anthropic provider adapter
 *
 * Handles Anthropic Messages API format for request building,
 * response parsing, and message formatting.
 */

import type { ContentPart, PromptContent } from '../types.js';
import type { TooledPromptEmitter } from '../events.js';
import type { ProviderAdapter, ToolCallInfo, ToolResultInfo, ParsedResponse, BuildRequestParams, BuildRequestResult } from './types.js';
import { parseDataUrl } from './utils.js';
import { parseSSEStream } from '../streaming.js';

const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

function convertImagePart(part: ContentPart): unknown {
  if (part.type === 'image_url') {
    try {
      const { mediaType, base64 } = parseDataUrl(part.image_url.url);
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
    } catch {
      // If not a data URL, pass through as URL reference
      return { type: 'image', source: { type: 'url', url: part.image_url.url } };
    }
  }
  return part;
}

function contentToAnthropicParts(content: PromptContent, prependImages?: ContentPart[]): unknown[] {
  const parts: unknown[] = [];

  // Prepend system images
  if (prependImages) {
    for (const img of prependImages) {
      parts.push(convertImagePart(img));
    }
  }

  if (typeof content === 'string') {
    parts.push({ type: 'text', text: content });
  } else {
    for (const part of content) {
      parts.push(convertImagePart(part));
    }
  }

  return parts;
}

export class AnthropicProvider implements ProviderAdapter {
  buildRequest(params: BuildRequestParams): BuildRequestResult {
    const url = params.apiUrl + '/messages';

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (params.apiKey) {
      headers['x-api-key'] = params.apiKey;
    }

    const body: Record<string, unknown> = {
      model: params.modelName,
      messages: params.messages,
      max_tokens: params.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
      ...(params.stream && { stream: true }),
      ...(params.temperature !== undefined && { temperature: params.temperature }),
    };

    // System prompt goes in dedicated field
    if (params.systemPrompt !== undefined) {
      if (typeof params.systemPrompt === 'string') {
        body.system = params.systemPrompt;
      } else {
        // ContentPart[] — extract text only (images were already separated)
        const textParts = params.systemPrompt
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map(p => ({ type: 'text', text: p.text }));
        body.system = textParts;
      }
    }

    // Tools in Anthropic format (flat, no type:'function' wrapper)
    if (params.tools.length > 0) {
      const anthropicTools = params.tools.map(meta => ({
        name: meta.name,
        description: meta.description,
        input_schema: meta.parameters as Record<string, unknown>,
      }));

      // If we have a schema and we're using the store pattern (tool_choice),
      // detect return_value tool and force it
      if (params.schema) {
        const storeToolName = params.tools.find(t => t.name === 'return_value')?.name;
        if (storeToolName) {
          body.tool_choice = { type: 'tool', name: storeToolName };
        }
      }

      body.tools = anthropicTools;
    }

    return { url, headers, body };
  }

  formatUserMessage(content: PromptContent, prependImages?: ContentPart[]): unknown {
    const parts = contentToAnthropicParts(content, prependImages);

    // Simplify single text part
    if (parts.length === 1 && (parts[0] as any).type === 'text' && !prependImages?.length) {
      return { role: 'user', content: (parts[0] as any).text };
    }

    return { role: 'user', content: parts };
  }

  formatAssistantMessage(content: string, toolCalls: ToolCallInfo[]): unknown {
    const contentBlocks: unknown[] = [];

    if (content) {
      contentBlocks.push({ type: 'text', text: content });
    }

    for (const tc of toolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.arguments);
      } catch {
        input = {};
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    return { role: 'assistant', content: contentBlocks };
  }

  formatToolResults(results: ToolResultInfo[]): unknown[] {
    // Anthropic batches all tool results in a single user message
    return [{
      role: 'user',
      content: results.map(tr => ({
        type: 'tool_result',
        tool_use_id: tr.id,
        content: tr.result,
      })),
    }];
  }

  async parseResponse(
    response: Response,
    streaming: boolean,
    emitter: TooledPromptEmitter,
  ): Promise<ParsedResponse> {
    let content = '';
    const toolCalls: ToolCallInfo[] = [];

    if (streaming && response.body) {
      const reader = response.body.getReader();
      let currentToolIndex = -1;

      for await (const parsed of parseSSEStream(reader)) {
        switch (parsed.type) {
          case 'content_block_start': {
            const block = parsed.content_block;
            if (block?.type === 'tool_use') {
              currentToolIndex = toolCalls.length;
              toolCalls.push({
                id: block.id || '',
                name: block.name || '',
                arguments: '',
              });
            }
            break;
          }
          case 'content_block_delta': {
            const delta = parsed.delta;
            if (delta?.type === 'text_delta' && delta.text) {
              emitter.emit('content', delta.text);
              content += delta.text;
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              emitter.emit('thinking', delta.thinking);
            } else if (delta?.type === 'input_json_delta' && delta.partial_json !== undefined) {
              if (currentToolIndex >= 0) {
                toolCalls[currentToolIndex].arguments += delta.partial_json;
              }
            }
            break;
          }
          case 'content_block_stop':
            currentToolIndex = -1;
            break;
          case 'message_stop':
            break;
        }
      }

      if (content) {
        emitter.emit('content', '\n');
      }
    } else {
      // Non-streaming response
      const data = await response.json() as {
        content?: Array<{
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        }>;
      };

      if (!data.content) {
        throw new Error('No response from LLM');
      }

      for (const block of data.content) {
        if (block.type === 'text' && block.text) {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || '',
            name: block.name || '',
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {}),
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
