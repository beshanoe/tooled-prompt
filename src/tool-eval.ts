/**
 * Code-action meta-tool
 *
 * Instead of the LLM calling tools one-by-one through the tool loop,
 * `toolEval` lets the LLM write a short JS function body that orchestrates
 * multiple tools in a single turn. The runtime executes it via AsyncFunction.
 */

import { tool } from './tool.js';
import {
  renderParam,
  renderReturns,
  renderTypedef,
  collectTypedefs,
  type Schema,
  type TypedefSource,
} from './jsdoc.js';
import { TOOL_SYMBOL, type ToolFunction } from './types.js';
import { preprocessCode } from './preprocess-code.js';

/**
 * Format a code error with line-annotated source context.
 * Acorn SyntaxErrors include a `loc` property with line/column.
 */
function formatCodeError(err: Error, code: string): string {
  const loc = (err as any).loc as { line: number; column: number } | undefined;
  if (!loc) return `Error: ${err.message}`;

  const lines = code.split('\n');
  const lineIdx = loc.line - 1;
  const start = Math.max(0, lineIdx - 1);
  const end = Math.min(lines.length, lineIdx + 2);

  const context = lines.slice(start, end).map((line, i) => {
    const lineNum = start + i + 1;
    const marker = lineNum === loc.line ? '>' : ' ';
    return `${marker} ${lineNum} | ${line}`;
  });

  // Add caret pointing to the column
  if (lineIdx >= start && lineIdx < end) {
    const caretIdx = context.findIndex((_, i) => start + i === lineIdx);
    const padding = `  ${loc.line} | `.length + loc.column;
    context.splice(caretIdx + 1, 0, ' '.repeat(padding) + '^');
  }

  return `SyntaxError: ${err.message}\n${context.join('\n')}`;
}

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
 *
 * Thin adapter: reads the tool's parameters/returns schemas and delegates
 * line rendering to `jsdoc.ts`. When `refs` names shared shapes, field types
 * collapse to typedef references (e.g. `{T1[]}`) instead of inline expansion.
 */
function buildSignature(
  fn: (...args: any[]) => any,
  meta: ToolFunction[typeof TOOL_SYMBOL],
  refs: Map<string, string>,
): string {
  const params = Object.entries((meta.parameters.properties || {}) as Record<string, Schema>);
  const required = new Set(meta.parameters.required || []);

  const lines: string[] = ['/**', ` * ${meta.description}`];

  for (const [name, schema] of params) {
    lines.push(...renderParam(name, schema, !required.has(name), refs));
  }

  if (meta.returnsSchema || meta.returns) {
    lines.push(...renderReturns(meta.returnsSchema as Schema | undefined, meta.returns || '', refs));
  }

  lines.push(' */');

  const paramList = params.map(([name]) => name).join(', ');
  lines.push(`async function ${fn.name || meta.name}(${paramList})`);
  return lines.join('\n');
}

/**
 * Build the full description for the tool_eval meta-tool.
 *
 * First runs a dedup pass across every tool's parameter/return schemas to
 * find object shapes worth promoting to `@typedef`. Shared shapes (used in
 * ≥2 places) and object returns (since dotted `@returns.field` is non-standard
 * JSDoc) get hoisted into a single typedef block, and every signature below
 * references them by name.
 */
function buildDescription(fns: ((...args: any[]) => any)[], tools: ToolFunction[]): string {
  const preamble = 'Execute JavaScript code that orchestrates multiple tool calls in a single turn.';

  const sources: TypedefSource[] = tools.map((t) => {
    const meta = t[TOOL_SYMBOL];
    return {
      paramSchemas: Object.values((meta.parameters.properties || {}) as Record<string, Schema>),
      returnSchema: meta.returnsSchema as Schema | undefined,
    };
  });
  const { typedefs, refs } = collectTypedefs(sources);

  let typedefBlock = '';
  if (typedefs.length > 0) {
    const blocks = typedefs.map((td) => ['/**', ...renderTypedef(td.name, td.schema, refs), ' */'].join('\n'));
    typedefBlock = `${blocks.join('\n\n')}\n\n`;
  }

  const signatures = fns.map((fn, i) => buildSignature(fn, tools[i][TOOL_SYMBOL], refs)).join('\n\n');

  return `${preamble}
Write the body of an async function. Available functions:

${typedefBlock}${signatures}

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

  // Wrap functions that have parseReturn to auto-parse their return values
  const scopeFns = fns.map((fn, i) => {
    const { parseReturn } = tools[i][TOOL_SYMBOL];
    if (!parseReturn) return fn;
    const parse = parseReturn;
    return async function (this: unknown, ...args: any[]) {
      return parse(await fn.apply(this, args));
    };
  });

  async function tool_eval(code: string): Promise<string | Uint8Array> {
    try {
      const processedCode = preprocessCode(code);
      const fn = new AsyncFunction(...fnNames, processedCode);
      let timer: ReturnType<typeof setTimeout>;
      const result = await Promise.race([
        fn(...scopeFns),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
      clearTimeout(timer!);

      if (result instanceof Uint8Array) return result;
      if (result === undefined || result === null) return 'OK';
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    } catch (err) {
      return formatCodeError(err as Error, code);
    }
  }

  return tool(tool_eval, {
    description: buildDescription(fns, tools),
    args: [['code', 'JavaScript async function body. Use await to call functions, return to produce a result.']],
  });
}
