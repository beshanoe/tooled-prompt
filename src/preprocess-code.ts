/**
 * AST-based preprocessing for toolEval code strings.
 *
 * Detects common LLM patterns that produce no return value and rewrites
 * the code so the result is captured:
 * - Bare expressions without `return` → auto-return the last expression
 * - Defined-but-not-called functions → auto-call the single uncalled one
 */

import { parse, type Node } from 'acorn';

interface AcornNode extends Node {
  type: string;
  body?: AcornNode[];
  expression?: AcornNode;
  callee?: AcornNode;
  id?: { name: string };
  name?: string;
  [key: string]: unknown;
}

/**
 * Collect all function names referenced as CallExpression callees
 * anywhere in the AST (recursive walk, no acorn-walk dependency).
 */
function collectCalledNames(node: AcornNode): Set<string> {
  const names = new Set<string>();

  function walk(n: unknown): void {
    if (!n || typeof n !== 'object') return;
    const obj = n as AcornNode;
    if (obj.type === 'CallExpression' && obj.callee?.type === 'Identifier' && obj.callee.name) {
      names.add(obj.callee.name);
    }
    for (const key of Object.keys(obj)) {
      if (key === 'type' || key === 'start' || key === 'end') continue;
      const val = (obj as Record<string, unknown>)[key];
      if (Array.isArray(val)) {
        for (const item of val) walk(item);
      } else if (val && typeof val === 'object' && (val as AcornNode).type) {
        walk(val);
      }
    }
  }

  walk(node);
  return names;
}

/**
 * Preprocess a code string before passing to AsyncFunction.
 *
 * If the code already has a top-level `return`, it is returned unchanged.
 * Otherwise:
 * - If the last statement is an expression, wraps it with `return (...)`.
 * - If there is exactly one uncalled top-level function declaration,
 *   appends `return await name()`.
 * - On parse failure, throws the acorn SyntaxError (includes line:column).
 */
export function preprocessCode(code: string): string {
  // allowAwaitOutsideFunction and allowReturnOutsideFunction are valid acorn
  // options but missing from the published type declarations.
  const ast = parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'script',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  } as any) as unknown as AcornNode;

  const body = ast.body;
  if (!body || body.length === 0) return code;

  // If there's already a top-level return, no rewriting needed
  if (body.some((stmt) => stmt.type === 'ReturnStatement')) return code;

  const last = body[body.length - 1];

  // Last statement is an expression → wrap with return
  // Use the inner expression's range to avoid including the trailing semicolon
  if (last.type === 'ExpressionStatement' && last.expression) {
    const expr = last.expression;
    // Bare arrow/function expression with no params → IIFE so it executes instead of being returned
    if (
      (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression') &&
      Array.isArray((expr as any).params) &&
      (expr as any).params.length === 0
    ) {
      return (
        code.slice(0, last.start) + 'return await (' + code.slice(expr.start, expr.end) + ')()' + code.slice(last.end)
      );
    }
    return code.slice(0, last.start) + 'return (' + code.slice(expr.start, expr.end) + ')' + code.slice(last.end);
  }

  // Collect top-level function declarations and find uncalled ones
  const declared = new Map<string, AcornNode>();
  for (const stmt of body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      declared.set(stmt.id.name, stmt);
    }
  }

  if (declared.size === 0) return code;

  const called = collectCalledNames(ast);
  const uncalled = [...declared.keys()].filter((name) => !called.has(name));

  if (uncalled.length === 1) {
    return code + `\nreturn await ${uncalled[0]}();`;
  }

  return code;
}
