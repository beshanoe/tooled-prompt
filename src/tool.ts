/**
 * Tool wrapper for marking functions as LLM tools
 *
 * Supports multiple ways to define tools:
 * - Auto-inference from function signature
 * - Simple schema: { field: 'description', 'field?': 'optional' }
 * - Zod schema for full type safety
 */

import type { ZodType } from 'zod';
import { requireZod } from './zod.js';
import { parseFunction } from './parser.js';
import {
  TOOL_SYMBOL,
  type JsonSchema,
  type ToolMetadata,
  type ToolFunction,
  type NamedFunction,
  type ToolOptions,
  type ArgsForFn,
  type ArgDescriptor,
  isZodSchema,
} from './types.js';

// Re-export for convenience
export { TOOL_SYMBOL, type ToolMetadata, type ToolFunction };

// Counter for anonymous functions
let anonymousCounter = 0;

/**
 * Convert a JSON Schema to a compact TS-like type string.
 * e.g. { type: "object", properties: { name: { type: "string" }, id: { type: "number" } } }
 *   → "{ name: string, id: number }"
 */
export function jsonSchemaToTypeString(schema: Record<string, unknown>): string {
  const type = schema.type as string | undefined;
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return items ? `${jsonSchemaToTypeString(items)}[]` : 'unknown[]';
  }
  if (type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    const req = new Set((schema.required as string[]) || []);
    const fields = Object.entries(props)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${jsonSchemaToTypeString(v)}`)
      .join(', ');
    return `{ ${fields} }`;
  }
  return 'object';
}

/**
 * Convert camelCase/PascalCase to snake_case.
 * Already-snake_case names pass through unchanged.
 */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/**
 * Reset anonymous counter (useful for testing)
 */
export function resetAnonymousCounter(): void {
  anonymousCounter = 0;
}

/**
 * Infer JSON Schema from parsed function parameters
 */
function inferSchema(parsed: ReturnType<typeof parseFunction>): JsonSchema {
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];

  for (const param of parsed.params) {
    properties[param.name] = {
      type: 'string',
      description: `The ${param.name} argument`,
    };
    if (!param.optional) required.push(param.name);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

/**
 * Check if a value is a tool function
 */
export function isTool(value: unknown): value is ToolFunction {
  return typeof value === 'function' && TOOL_SYMBOL in value;
}

/**
 * Get tool metadata from a tool function
 */
export function getToolMetadata(fn: ToolFunction): ToolMetadata {
  return fn[TOOL_SYMBOL];
}

/**
 * Wrap a function with tool metadata for LLM use
 *
 * Args is always an array where each element corresponds to a function parameter:
 * - string: description only, param name from parsed function
 * - [name, desc]: explicit param name and description
 * - ZodType: Zod schema, param name from .meta({ name }) or parsed function
 *
 * @example
 * ```typescript
 * // Auto-inferred
 * tool(readFile);
 *
 * // String descriptions
 * tool(copyFile, {
 *   description: 'Copy a file',
 *   args: ['Source path', 'Destination path']
 * });
 *
 * // Tuple [name, description]
 * tool(search, {
 *   args: [['query', 'Search query'], ['limit', 'Max results']]
 * });
 *
 * // Zod schemas (arity + type checked)
 * tool(readFile, {
 *   args: [z.string().describe('Path to the file')]
 * });
 *
 * // Object syntax for const arrow functions
 * const myFunc = async (x: string) => x.toUpperCase();
 * tool({ myFunc }, { args: ['Input text'] });
 * ```
 */
// Direct function overloads
export function tool<T extends (...args: any[]) => any>(fn: T): ToolFunction<T>;
export function tool<T extends (...args: any[]) => any>(fn: T, options: ToolOptions<T>): ToolFunction<T>;
// Object syntax overloads - extract function type from the object value
export function tool<T extends (...args: any[]) => any>(namedFn: { [K: string]: T }): ToolFunction<T>;
export function tool<T extends (...args: any[]) => any>(
  namedFn: { [K: string]: T },
  options: ToolOptions<T>,
): ToolFunction<T>;
export function tool<T extends (...args: any[]) => any>(
  fnOrNamed: T | NamedFunction,
  options?: ToolOptions<T>,
): ToolFunction<T> {
  const { description, args, returns } = options || {};
  // Check if it's object syntax: { myFunc }
  if (typeof fnOrNamed === 'object' && fnOrNamed !== null && !isZodSchema(fnOrNamed)) {
    const entries = Object.entries(fnOrNamed);
    if (entries.length !== 1) {
      throw new Error('tool() object syntax requires exactly one function: tool({ myFunc })');
    }
    const [name, fn] = entries[0];
    if (typeof fn !== 'function') {
      throw new Error('tool() object value must be a function');
    }
    // Proceed with extracted name and function
    return toolImpl(fn as T, name, description, args, returns as string | ZodType | undefined);
  }

  // Original path: direct function
  return toolImpl(fnOrNamed as T, undefined, description, args, returns as string | ZodType | undefined);
}

/**
 * Internal implementation that handles the actual tool wrapping
 */
function toolImpl<T extends (...args: any[]) => any>(
  fn: T,
  explicitName: string | undefined,
  description?: string,
  schema?: ArgsForFn<T>,
  returns?: string | ZodType,
): ToolFunction<T> {
  // If already a tool, return as-is
  if (isTool(fn)) {
    return fn;
  }

  const parsed = parseFunction(fn);

  // Use explicit name, then fn.name, otherwise generate "tool_N"
  const rawName = explicitName || fn.name || `tool_${++anonymousCounter}`;
  const name = toSnakeCase(rawName);

  let parameters: JsonSchema;
  if (schema) {
    const arr = schema as ArgDescriptor[];
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (let i = 0; i < arr.length; i++) {
      const elem = arr[i];
      const parsedParam = parsed.params[i];

      if (typeof elem === 'string') {
        // String descriptor: description only, name from parsed function
        const paramName = parsedParam?.name || `arg${i}`;
        properties[paramName] = { type: 'string', description: elem };
        if (!parsedParam?.optional) required.push(paramName);
      } else if (Array.isArray(elem)) {
        // Tuple [name, description]
        const [paramName, desc] = elem;
        properties[paramName] = { type: 'string', description: desc };
        if (!parsedParam?.optional) required.push(paramName);
      } else {
        // ZodType — user passed a Zod descriptor, so Zod is installed
        const z = requireZod();
        const zodSchema = elem as ZodType;
        const meta = z.globalRegistry.get(zodSchema);
        const paramName = (meta as any)?.name || parsedParam?.name || `arg${i}`;
        const jsonSchema = z.toJSONSchema(zodSchema);
        properties[paramName] = jsonSchema;
        const isZodOptional = (zodSchema as any)._zod?.def?.type === 'optional';
        if (!parsedParam?.optional && !isZodOptional) required.push(paramName);
      }
    }

    parameters = {
      type: 'object',
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    } as JsonSchema;
  } else {
    parameters = inferSchema(parsed);
  }

  // Resolve returns: description, JSON schema, and optional runtime parser
  let resolvedReturns: string | undefined;
  let returnsSchema: Record<string, unknown> | undefined;
  let parseReturn: ((raw: unknown) => unknown) | undefined;
  if (returns != null) {
    if (typeof returns === 'string') {
      resolvedReturns = returns;
    } else {
      const z = requireZod();
      returnsSchema = z.toJSONSchema(returns) as Record<string, unknown>;
      const meta = z.globalRegistry.get(returns);
      resolvedReturns = (meta as any)?.description as string | undefined;
      const zodReturns = returns;
      parseReturn = (raw: unknown) => zodReturns.parse(raw);
    }
  }

  const metadata: ToolMetadata = {
    name,
    description: description || `The ${name} function`,
    parameters,
    returns: resolvedReturns,
    returnsSchema,
    parseReturn,
  };

  // Attach metadata to the function
  (fn as any)[TOOL_SYMBOL] = metadata;

  return fn as any as ToolFunction<T>;
}
