/**
 * Provider adapter interface
 *
 * Each provider (OpenAI, Anthropic, Ollama) implements this interface
 * to handle API-specific request/response formatting.
 */

import type { ToolMetadata, ContentPart, PromptContent } from '../types.js';
import type { TooledPromptEmitter } from '../events.js';

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResultInfo {
  id: string;
  name: string;
  result: string;
}

export interface ParsedResponse {
  content: string;
  toolCalls: ToolCallInfo[];
}

export interface BuildRequestParams {
  apiUrl: string;
  apiKey: string | undefined;
  modelName: string;
  messages: unknown[];
  tools: ToolMetadata[];
  stream: boolean;
  temperature: number | undefined;
  maxTokens: number | undefined;
  systemPrompt?: PromptContent;
  schema?: { jsonSchema: Record<string, unknown> };
}

export interface BuildRequestResult {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProviderAdapter<TMessage = unknown> {
  /** Build the full HTTP request for one loop iteration */
  buildRequest(params: BuildRequestParams): BuildRequestResult;

  /** Format the initial user message from prompt content, optionally prepending system images */
  formatUserMessage(content: PromptContent, prependImages?: ContentPart[]): TMessage;

  /** Format assistant response + tool calls for message history */
  formatAssistantMessage(content: string, toolCalls: ToolCallInfo[]): TMessage;

  /** Format tool results for history. Returns message(s) to append. */
  formatToolResults(results: ToolResultInfo[]): TMessage[];

  /** Parse HTTP response (streaming or non-streaming) into common format */
  parseResponse(
    response: Response,
    streaming: boolean,
    emitter: TooledPromptEmitter,
  ): Promise<ParsedResponse>;
}
