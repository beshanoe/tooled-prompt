/**
 * Store pattern for capturing structured LLM output via tool calls
 *
 * A store looks like a tool to the LLM. The LLM "stores" a value by calling
 * this tool with structured arguments matching the schema. After execution,
 * store.get() returns the fully-typed result.
 *
 * @example
 * ```typescript
 * const changeLog = store(changelogSchema);
 * await prompt`... Save the result in ${changeLog}.`();
 * const result = changeLog.get(); // fully typed
 * ```
 */

import type { ZodType } from 'zod';
import {
  TOOL_SYMBOL,
  type ToolMetadata,
  type JsonSchema,
  type SimpleSchema,
  type ResolvedSchema,
  resolveSchema,
} from './types.js';

/**
 * Symbol marking the return sentinel object
 */
export const RETURN_SYMBOL = Symbol.for('tooled-prompt.return');

/**
 * Sentinel value used in template literals to mark where structured output should be captured.
 * When `prompt.return` appears in a template AND a schema is passed, the executor
 * creates a store tool at that position and stops as soon as it's filled.
 */
export const RETURN_SENTINEL: { readonly [RETURN_SYMBOL]: true } = { [RETURN_SYMBOL]: true };

/**
 * A store is a callable (tool) that also exposes .get() for retrieval
 */
export interface Store<T> {
  (...args: any[]): string;
  [TOOL_SYMBOL]: ToolMetadata;
  get(): T | undefined;
}

/** Counter for generating unique store tool names */
let storeCounter = 0;

/** Reset store counter (useful for testing) */
export function resetStoreCounter(): void {
  storeCounter = 0;
}

/**
 * Infer the output type from a SimpleSchema
 */
type SimpleSchemaOutput<T extends SimpleSchema> = {
  [K in keyof T as K extends `${infer Base}?` ? Base : K]: string;
};

/**
 * Create a store from a name and resolved schema (shared logic for store() and factory return stores)
 */
export function createStore<T>(name: string, schema: ResolvedSchema<T>): Store<T> {
  // Use JSON Schema for the tool parameters
  const jsonSchema = schema.jsonSchema as JsonSchema;

  // Storage for the value
  let stored: { value: T } | undefined;

  // The property keys determine positional arg order (matching executor dispatch)
  const propKeys = Object.keys(jsonSchema.properties || {});

  // The store function: receives positional args, reconstructs object, validates, stores
  const fn = (...args: any[]): string => {
    // Reconstruct the object from positional args
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < propKeys.length; i++) {
      if (i < args.length && args[i] !== undefined) {
        obj[propKeys[i]] = args[i];
      }
    }

    // Validate with the schema's parse function
    const result = schema.parse(obj);
    stored = { value: result };
    return 'Value stored successfully';
  };

  // Attach tool metadata
  const metadata: ToolMetadata = {
    name,
    description: 'Store a structured value',
    parameters: jsonSchema,
  };
  (fn as any)[TOOL_SYMBOL] = metadata;

  // Attach .get() method
  (fn as any).get = (): T | undefined => {
    return stored?.value;
  };

  return fn as any as Store<T>;
}

/**
 * Create a typed store that captures structured LLM output
 *
 * @param schema - Zod schema or SimpleSchema describing the expected structure
 * @returns A Store that acts as a tool and provides .get() for retrieval
 */
export function store<T>(schema: ZodType<T>): Store<T>;
export function store<T extends SimpleSchema>(schema: T): Store<SimpleSchemaOutput<T>>;
export function store(schema: ZodType | SimpleSchema): Store<any> {
  const name = `store_value_${++storeCounter}`;

  return createStore(name, resolveSchema(schema));
}
