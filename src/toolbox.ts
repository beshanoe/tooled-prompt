/**
 * Deferred tool loading via a meta-tool
 *
 * Instead of sending all tool schemas upfront, only a `tool_search` meta-tool
 * is sent. When the LLM calls it, matching tools are activated and their
 * schemas appear in the next loop iteration.
 */

import { tool } from './tool.js';
import { TOOL_SYMBOL, type ToolFunction } from './types.js';

/**
 * Symbol used to mark a tool as a toolbox (carries the pending queue)
 */
export const TOOLBOX_SYMBOL = Symbol.for('tooled-prompt.toolbox');

/**
 * Metadata attached to a toolbox meta-tool
 */
export interface ToolboxMeta {
  pending: ToolFunction[];
}

/**
 * A tool function that also carries toolbox metadata
 */
export type ToolboxFunction = ToolFunction & {
  [TOOLBOX_SYMBOL]: ToolboxMeta;
};

/**
 * Custom match function for tool search.
 * Receives the query and all registered tools, returns the matching subset.
 */
export type ToolSearchMatcher = (query: string, tools: ToolFunction[]) => ToolFunction[] | Promise<ToolFunction[]>;

/**
 * Options for toolSearch
 */
export interface ToolSearchOptions {
  match?: ToolSearchMatcher;
}

/**
 * Default substring matcher: splits query into terms and matches against tool name + description.
 */
function defaultMatch(query: string, tools: ToolFunction[]): ToolFunction[] {
  const terms = query.toLowerCase().split(/\s+/);
  return tools.filter((t) => {
    const meta = t[TOOL_SYMBOL];
    const haystack = `${meta.name} ${meta.description}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  });
}

/**
 * Format matched tools as a description string for the LLM.
 */
function formatMatches(matches: ToolFunction[]): string {
  return matches
    .map((t) => {
      const m = t[TOOL_SYMBOL];
      const params = Object.entries(m.parameters.properties || {})
        .map(([k, v]) => `${k}: ${(v as any).description || (v as any).type}`)
        .join(', ');
      return `- ${m.name}: ${m.description} (${params})`;
    })
    .join('\n');
}

/**
 * Create a deferred tool loader.
 *
 * Accepts raw functions or `tool()`-wrapped functions, with an optional
 * options object as the last argument. Only a `tool_search` meta-tool is
 * sent to the LLM. When it calls `tool_search("query")`, matching tools
 * are activated for the next iteration.
 *
 * @example
 * ```ts
 * // Default substring matching
 * const search = toolSearch(readFile, writeFile, sendEmail)
 *
 * // Custom match function (embeddings, LLM-based, etc.)
 * const search = toolSearch(readFile, writeFile, sendEmail, {
 *   match: async (query, tools) => { ... }
 * })
 *
 * const result = await prompt`Help the user: ${userMessage} ${search}`()
 * ```
 */
export function toolSearch(
  ...args: [...((...args: any[]) => any)[], ToolSearchOptions] | ((...args: any[]) => any)[]
): ToolboxFunction {
  // Detect trailing options object
  let options: ToolSearchOptions = {};
  let fns: ((...args: any[]) => any)[];
  const last = args[args.length - 1];
  if (last && typeof last === 'object' && !(TOOL_SYMBOL in last)) {
    options = last as ToolSearchOptions;
    fns = args.slice(0, -1) as ((...args: any[]) => any)[];
  } else {
    fns = args as ((...args: any[]) => any)[];
  }

  const matchFn = options.match ?? defaultMatch;

  // Ensure all functions are tool-wrapped
  const tools: ToolFunction[] = fns.map((fn) => {
    if (typeof fn === 'function' && TOOL_SYMBOL in fn) {
      return fn as ToolFunction;
    }
    return tool(fn as (...args: any[]) => any);
  });

  const pending: ToolFunction[] = [];

  async function tool_search(query: string): Promise<string> {
    const matches = await matchFn(query, tools);

    if (matches.length === 0) {
      return `No tools found matching "${query}". Try a different search term.`;
    }

    // Queue matched tools for injection into the native tools array
    for (const match of matches) {
      if (!pending.some((p) => p[TOOL_SYMBOL].name === match[TOOL_SYMBOL].name)) {
        pending.push(match);
      }
    }

    return formatMatches(matches);
  }

  const metaTool = tool(tool_search, {
    description: "Search for available tools by keyword. Call this before using a tool you haven't discovered yet.",
    args: [['query', 'Search query to find relevant tools (e.g. "file", "email", "database")']],
  }) as ToolboxFunction;

  metaTool[TOOLBOX_SYMBOL] = { pending };

  return metaTool;
}
