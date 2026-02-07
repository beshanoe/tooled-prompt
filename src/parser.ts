/**
 * Function introspection for smart tool recognition
 *
 * Extracts function name and parameters from fn.toString()
 *
 * IMPORTANT: This parses JavaScript at runtime, NOT TypeScript source.
 * TypeScript's `?` optional syntax is stripped during compilation.
 * Only parameters with default values can be detected as optional.
 *
 * Examples:
 * - fn(x?: string) → compiled to fn(x) → NOT detectable as optional
 * - fn(x = 'default') → compiled to fn(x = 'default') → IS detectable as optional
 */

/**
 * Parsed function information
 */
export interface ParsedFunction {
  name: string;
  params: Array<{ name: string; optional: boolean }>;
}

/**
 * Parse a function to extract its name and parameters
 *
 * Handles:
 * - Regular functions: function foo(a, b) {}
 * - Async functions: async function foo(a, b) {}
 * - Arrow functions: (a, b) => {}
 * - Async arrow functions: async (a, b) => {}
 * - Methods: foo(a, b) {}
 * - TypeScript typed params: (a: string, b?: number) => {}
 */
export function parseFunction(fn: Function): ParsedFunction {
  const name = fn.name || 'anonymous';
  const str = fn.toString();

  // Extract params from function signature
  // Pattern 1: function name(params), async function name(params), (params) =>, async (params) =>
  let match = str.match(/^(?:async\s+)?(?:function\s*\w*)?\s*\(([^)]*)\)/);

  // Pattern 2: Arrow function with single unparenthesized param: async param => {}, param => {}
  if (!match) {
    match = str.match(/^(?:async\s+)?(\w+)\s*=>/);
  }

  const paramsStr = match?.[1] || '';

  if (!paramsStr.trim()) {
    return { name, params: [] };
  }

  const params = paramsStr
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // Check for default value BEFORE stripping it - indicates optional param
      // At runtime, "name = 'default'" is the only way to detect optionality
      // TypeScript's `?` syntax is stripped during compilation
      const hasDefault = p.includes('=');

      // Strip type annotations: "name: string" → "name", "name?: string" → "name?"
      // Strip default values: "name = 'default'" → "name"
      let paramName = p.split(':')[0].split('=')[0].trim();

      // At runtime, TypeScript's `?` is usually stripped, but check anyway
      const hasTsOptional = paramName.endsWith('?');

      return {
        name: paramName.replace('?', ''),
        optional: hasDefault || hasTsOptional,
      };
    });

  return { name, params };
}
