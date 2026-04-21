/**
 * Function introspection for LLM tool wrapping.
 *
 * Runs at runtime against compiled JavaScript — TypeScript syntax
 * (type annotations, `?` optional, generics) has already been stripped
 * before `fn.toString()` returns. We only need two things:
 *
 *   1. Param names (for auto-generated JSON Schema property keys).
 *   2. Whether each param has a default value — the only form of
 *      optionality that survives compilation.
 *
 * Acorn does the actual parsing; this module just picks a wrapping
 * that makes the source a valid expression and walks the resulting
 * param AST.
 */

import { parse } from 'acorn';

export interface ParsedFunction {
  name: string;
  params: Array<{ name: string; optional: boolean }>;
}

interface ParamNode {
  type: string;
  name?: string;
  left?: ParamNode;
  argument?: ParamNode;
}

interface FnNode {
  type: string;
  params: ParamNode[];
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export function parseFunction(fn: Function): ParsedFunction {
  const name = fn.name || 'anonymous';
  const node = parseToFunctionNode(fn.toString());
  if (!node) return { name, params: [] };
  return { name, params: node.params.map(paramInfo) };
}

/**
 * Parse the function source into a function-like AST node.
 *
 * Tries two wrappings so every shape `fn.toString()` can produce is covered:
 *   - `(src)`     → function declarations/expressions, arrows, async variants
 *   - `({src})`   → object/class method shorthand, e.g. `foo(a) {}`
 */
function parseToFunctionNode(src: string): FnNode | null {
  const asExpression = tryParse(`(${src})`, (ast) => ast.body[0]?.expression);
  if (isFunctionNode(asExpression)) return asExpression;

  const asMethod = tryParse(`({${src}})`, (ast) => ast.body[0]?.expression?.properties?.[0]?.value);
  if (isFunctionNode(asMethod)) return asMethod;

  return null;
}

function tryParse(source: string, pick: (ast: any) => unknown): unknown {
  try {
    const ast = parse(source, { ecmaVersion: 'latest' });
    return pick(ast);
  } catch {
    return null;
  }
}

function isFunctionNode(node: unknown): node is FnNode {
  const t = (node as { type?: string } | null)?.type;
  return t === 'FunctionExpression' || t === 'ArrowFunctionExpression';
}

/**
 * Convert an acorn param-pattern node into `{ name, optional }`.
 *
 *   Identifier         `x`         → { name: 'x',      optional: false }
 *   AssignmentPattern  `x = 1`     → { name: <inner>,  optional: true  }
 *   RestElement        `...rest`   → { name: 'rest',   optional: true  }
 *   ObjectPattern      `{ a, b }`  → { name: 'args<i>',optional: false }
 *   ArrayPattern       `[x, y]`    → { name: 'args<i>',optional: false }
 */
function paramInfo(node: ParamNode, index: number): { name: string; optional: boolean } {
  switch (node.type) {
    case 'Identifier':
      return { name: node.name!, optional: false };
    case 'AssignmentPattern':
      return { name: paramInfo(node.left!, index).name, optional: true };
    case 'RestElement':
      return { name: paramInfo(node.argument!, index).name, optional: true };
    default:
      // ObjectPattern, ArrayPattern — no single recoverable name
      return { name: `args${index}`, optional: false };
  }
}
