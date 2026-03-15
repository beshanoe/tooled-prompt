/**
 * Code-action meta-tool
 *
 * Instead of the LLM calling tools one-by-one through the tool loop,
 * `toolEval` lets the LLM write a short JS function body that orchestrates
 * multiple tools in a single turn. The runtime executes it via AsyncFunction.
 */

import { tool } from './tool.js';
import { TOOL_SYMBOL, type ToolFunction } from './types.js';

/**
 * Options for toolEval
 */
export interface ToolEvalOptions {
  /** Execution timeout in milliseconds (default: 30000) */
  timeout?: number;
}

const AsyncFunction: new (...args: string[]) => (...args: any[]) => Promise<any> = Object.getPrototypeOf(
  async function () {},
).constructor;

/**
 * Build a JSDoc-style signature string for a single function.
 */
function buildSignature(fn: (...args: any[]) => any, meta: ToolFunction[typeof TOOL_SYMBOL]): string {
  const params = Object.entries(meta.parameters.properties || {});

  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * ${meta.description}`);
  for (const [name, prop] of params) {
    const desc = (prop as any).description || '';
    lines.push(` * @param ${name}${desc ? ` - ${desc}` : ''}`);
  }
  lines.push(' */');

  const paramList = params.map(([name]) => name).join(', ');
  lines.push(`async function ${fn.name || meta.name}(${paramList})`);
  return lines.join('\n');
}

/**
 * Build the full description for the tool_eval meta-tool.
 */
function buildDescription(fns: ((...args: any[]) => any)[], tools: ToolFunction[]): string {
  const preamble = 'Execute JavaScript code that orchestrates multiple tool calls in a single turn.';

  const signatures = fns.map((fn, i) => buildSignature(fn, tools[i][TOOL_SYMBOL])).join('\n\n');

  return `${preamble}
Write the body of an async function (no wrapper needed). Available functions:

${signatures}

Use \`return\` to produce a result.`;
}

/**
 * Create a code-action meta-tool.
 *
 * Accepts raw functions or `tool()`-wrapped functions, with an optional
 * options object as the last argument. Only a `tool_eval` meta-tool is
 * sent to the LLM. When the LLM calls it with a JavaScript function body,
 * the code is executed with the registered functions available in scope.
 *
 * @example
 * ```ts
 * const exec = toolEval(add, multiply, readFile, sendEmail);
 *
 * const result = await prompt`
 *   Read example.txt, multiply 123 by 456, and email the result.
 *   ${exec}
 * `();
 * ```
 */
export function toolEval(
  ...args: [...((...args: any[]) => any)[], ToolEvalOptions] | ((...args: any[]) => any)[]
): ToolFunction {
  // Detect trailing options object
  let options: ToolEvalOptions = {};
  let fns: ((...args: any[]) => any)[];
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !(TOOL_SYMBOL in last)) {
    options = last as ToolEvalOptions;
    fns = args.slice(0, -1) as ((...args: any[]) => any)[];
  } else {
    fns = args as ((...args: any[]) => any)[];
  }

  const timeoutMs = options.timeout ?? 30000;

  // Ensure all functions have tool metadata (for description generation)
  const tools: ToolFunction[] = fns.map((fn) => {
    if (typeof fn === 'function' && TOOL_SYMBOL in fn) {
      return fn as ToolFunction;
    }
    return tool(fn as (...args: any[]) => any);
  });

  // Use original fn.name for the eval scope (camelCase, natural JS)
  const fnNames = fns.map((fn, i) => fn.name || tools[i][TOOL_SYMBOL].name);

  async function tool_eval(code: string): Promise<string> {
    try {
      const fn = new AsyncFunction(...fnNames, code);
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        fn(...fns),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      clearTimeout(timer!);

      if (result === undefined || result === null) return 'OK';
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }

  return tool(tool_eval, {
    description: buildDescription(fns, tools),
    args: [['code', 'JavaScript async function body. Use await to call functions, return to produce a result.']],
  });
}
