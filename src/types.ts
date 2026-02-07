/**
 * Shared type definitions for tooled-prompt
 */

import type { ZodType } from 'zod';
import { requireZod } from './zod.js';
import type { TooledPromptEvents } from './events.js';

/**
 * Object containing a single named function for tool() syntax
 * Example: tool({ myFunc }) extracts name "myFunc" from the key
 */
export type NamedFunction = { [key: string]: (...args: any[]) => any };

/**
 * Symbol used to mark functions as LLM tools
 * Using Symbol.for() ensures the same symbol across module boundaries
 */
export const TOOL_SYMBOL = Symbol.for('tooled-prompt.tool');

/**
 * JSON Schema type for tool parameters
 */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string }>;
  required?: string[];
  [key: string]: unknown;
}

/**
 * Simple schema format: { field: 'description', 'field?': 'optional description' }
 */
export type SimpleSchema = Record<string, string>;

/**
 * A single arg descriptor: string description, [name, description] tuple, or Zod schema
 */
export type ArgDescriptor = string | [string, string] | ZodType;

/**
 * Recursively maps a function's parameter tuple to a tuple of arg descriptors.
 * Each position accepts a string, [name, desc] tuple, or a type-checked Zod schema.
 */
type ArgDescriptorTuple<T extends any[]> =
  T extends []
    ? []
    : T extends [infer H, ...infer R extends any[]]
      ? [string | [string, string] | { _zod: { output: H } }, ...ArgDescriptorTuple<R>]
      : T extends [(infer H)?]
        ? [(string | [string, string] | { _zod: { output: NonNullable<H> } })?]
        : [];

/**
 * Valid args for a tool function: always an array of arg descriptors.
 * 0-arg functions get `never` (no args allowed).
 */
export type ArgsForFn<T extends (...args: any[]) => any> =
  Parameters<T>['length'] extends 0 ? never : ArgDescriptorTuple<Parameters<T>>;

/**
 * Type-safe options for tool()
 */
export interface ToolOptions<T extends (...args: any[]) => any = (...args: any[]) => any> {
  description?: string;
  args?: ArgsForFn<T>;
}

/**
 * Metadata describing a tool function
 */
export interface ToolMetadata {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * A function that has been wrapped with tool metadata
 */
export interface ToolFunction<T extends (...args: any[]) => any = (...args: any[]) => any> {
  (...args: Parameters<T>): ReturnType<T>;
  [TOOL_SYMBOL]: ToolMetadata;
}

/**
 * Check if a value is a Zod schema
 */
export function isZodSchema(value: unknown): value is ZodType {
  return value !== null && typeof value === 'object' && '_def' in value;
}

/**
 * Check if a value is a SimpleSchema (plain object with string values)
 */
export function isSimpleSchema(value: unknown): value is SimpleSchema {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  // Must have at least one key
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return false;
  }
  // All values must be strings
  return keys.every(key => typeof (value as Record<string, unknown>)[key] === 'string');
}

/**
 * A resolved schema ready for use by executor/store — contains a JSON Schema
 * and a parse function. Abstracts over ZodType and SimpleSchema so downstream
 * code never imports Zod directly.
 */
export interface ResolvedSchema<T = unknown> {
  jsonSchema: Record<string, unknown>;
  parse(data: unknown): T;
}

/**
 * Convert SimpleSchema to JSON Schema directly (no Zod needed).
 * All SimpleSchema fields are strings; optional fields are indicated by a trailing '?'.
 */
export function simpleSchemaToJsonSchema(simple: SimpleSchema): JsonSchema {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  for (const [key, desc] of Object.entries(simple)) {
    const isOptional = key.endsWith('?');
    const cleanKey = isOptional ? key.slice(0, -1) : key;
    properties[cleanKey] = { type: 'string', description: desc };
    if (!isOptional) required.push(cleanKey);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

/**
 * Create a parser/validator for a SimpleSchema.
 * Checks that required string fields are present and all values are strings.
 */
export function createSimpleSchemaParser(simple: SimpleSchema): (data: unknown) => Record<string, string | undefined> {
  const fields: Array<{ cleanKey: string; optional: boolean }> = [];
  for (const key of Object.keys(simple)) {
    const isOptional = key.endsWith('?');
    const cleanKey = isOptional ? key.slice(0, -1) : key;
    fields.push({ cleanKey, optional: isOptional });
  }

  return (data: unknown) => {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Expected an object');
    }
    const obj = data as Record<string, unknown>;
    const result: Record<string, string | undefined> = {};

    for (const { cleanKey, optional } of fields) {
      const val = obj[cleanKey];
      if (val === undefined || val === null) {
        if (!optional) {
          throw new Error(`Missing required field: "${cleanKey}"`);
        }
        // omit undefined optional fields from result
        continue;
      }
      if (typeof val !== 'string') {
        throw new Error(`Field "${cleanKey}" must be a string, got ${typeof val}`);
      }
      result[cleanKey] = val;
    }
    return result;
  };
}

/**
 * Resolve a ZodType or SimpleSchema into a ResolvedSchema.
 * - ZodType path: uses requireZod().toJSONSchema() + schema.parse() (user has Zod)
 * - SimpleSchema path: uses simpleSchemaToJsonSchema + createSimpleSchemaParser (no Zod)
 */
export function resolveSchema<T>(schema: ZodType<T> | SimpleSchema): ResolvedSchema<T> {
  if (isZodSchema(schema)) {
    const z = requireZod();
    return {
      jsonSchema: z.toJSONSchema(schema),
      parse: (data: unknown) => (schema as ZodType<T>).parse(data),
    };
  }
  // SimpleSchema path — no Zod needed
  const simple = schema as SimpleSchema;
  return {
    jsonSchema: simpleSchemaToJsonSchema(simple),
    parse: createSimpleSchemaParser(simple) as (data: unknown) => T,
  };
}

/**
 * Configuration options (all fields optional for user-facing API)
 */
export interface TooledPromptConfig {
  /** LLM API endpoint URL */
  llmUrl?: string;
  /** Model name to use */
  llmModel?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Maximum iterations in tool loop */
  maxIterations?: number;
  /** Temperature for generation */
  temperature?: number;
  /** Enable streaming output */
  stream?: boolean;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** When true, suppresses default console output. Custom event handlers still fire. */
  silent?: boolean;
  /** When true, streams full thinking content. When false (default), shows only [Thinking] ... label. */
  showThinking?: boolean;
}

/**
 * Resolved configuration (all fields have values after merging defaults)
 */
export interface ResolvedTooledPromptConfig {
  /** LLM API endpoint URL */
  llmUrl: string;
  /** Model name to use */
  llmModel: string;
  /** API key for authentication */
  apiKey: string | undefined;
  /** Maximum iterations in tool loop */
  maxIterations: number | undefined;
  /** Temperature for generation */
  temperature: number | undefined;
  /** Enable streaming output */
  stream: boolean;
  /** Request timeout in milliseconds */
  timeout: number;
  /** When true, suppresses default console output. Custom event handlers still fire. */
  silent: boolean;
  /** When true, streams full thinking content. When false (default), shows only [Thinking] ... label. */
  showThinking: boolean;
}

/**
 * Result from executing a prompt (without schema)
 */
export interface ExecutionResult {
  /** Whether execution completed successfully */
  success: boolean;
  /** Final message from the LLM */
  message?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Wrapper for prompt execution results.
 * Provides an extensible envelope that will later include tool usage stats and other metadata.
 */
export interface PromptResult<T> {
  data: T;
}

/**
 * Prompt executor - callable function returned by prompt``
 * (Defined here to avoid circular imports between factory and prompt)
 */
export interface PromptExecutor {
  /** Execute without schema - returns string message */
  (config?: TooledPromptConfig): Promise<PromptResult<string>>;
  /** Execute with Zod schema - returns typed, validated data */
  <T>(schema: ZodType<T>, config?: TooledPromptConfig): Promise<PromptResult<T>>;
  /** Execute with SimpleSchema - returns object with string fields */
  <T extends SimpleSchema>(schema: T, config?: TooledPromptConfig): Promise<PromptResult<{ [K in keyof T as K extends `${infer Base}?` ? Base : K]: string }>>;
}

/**
 * A tooled-prompt instance with its own configuration
 */
export interface TooledPromptInstance {
  /** Tagged template for creating prompts, with `.return` sentinel for structured output */
  prompt: ((strings: TemplateStringsArray, ...values: unknown[]) => PromptExecutor) & {
    /** Sentinel value — use in template to capture structured output via a store tool */
    readonly return: object;
  };
  /** Tool wrapper function */
  tool: typeof import('./tool.js').tool;
  /** Update the instance configuration */
  setConfig: (config: TooledPromptConfig) => void;
  /** Subscribe to an event */
  on<K extends keyof TooledPromptEvents>(event: K, handler: TooledPromptEvents[K]): void;
  /** Unsubscribe from an event */
  off<K extends keyof TooledPromptEvents>(event: K, handler: TooledPromptEvents[K]): void;
}

/**
 * A single content part in a multi-part user message (text or image)
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Prompt content: plain string when no images, content array when images are present
 */
export type PromptContent = string | ContentPart[];

// Re-export event types for convenience
export type { TooledPromptEvents } from './events.js';
