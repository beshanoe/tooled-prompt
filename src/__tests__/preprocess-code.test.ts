import { describe, it, expect } from 'vitest';
import { preprocessCode } from '../preprocess-code.js';

describe('preprocessCode', () => {
  it('returns code unchanged when it has a top-level return', () => {
    const code = 'return await foo()';
    expect(preprocessCode(code)).toBe(code);
  });

  it('returns code unchanged when return is not the last statement', () => {
    const code = 'const x = 1;\nreturn x;';
    expect(preprocessCode(code)).toBe(code);
  });

  it('wraps a bare expression with return', () => {
    expect(preprocessCode('await listReminders()')).toBe('return (await listReminders())');
  });

  it('wraps the last expression when preceded by other statements', () => {
    const code = 'const x = 1;\nawait foo(x)';
    expect(preprocessCode(code)).toBe('const x = 1;\nreturn (await foo(x))');
  });

  it('wraps a simple function call expression', () => {
    expect(preprocessCode('foo()')).toBe('return (foo())');
  });

  it('auto-calls a single uncalled function declaration', () => {
    const code = 'async function main() {\n  return await foo();\n}';
    expect(preprocessCode(code)).toBe(code + '\nreturn await main();');
  });

  it('auto-calls a single uncalled sync function declaration', () => {
    const code = 'function run() {\n  return 42;\n}';
    expect(preprocessCode(code)).toBe(code + '\nreturn await run();');
  });

  it('does not auto-call when all functions are called', () => {
    const code = 'function helper() { return 1; }\nhelper()';
    // last statement is ExpressionStatement (the call), so it gets return-wrapped
    expect(preprocessCode(code)).toBe('function helper() { return 1; }\nreturn (helper())');
  });

  it('does not guess when multiple functions are uncalled', () => {
    const code = 'function a() { return 1; }\nfunction b() { return 2; }';
    expect(preprocessCode(code)).toBe(code);
  });

  it('auto-calls the single uncalled function when others are called', () => {
    const code = 'function helper() { return 1; }\nfunction main() { return helper(); }';
    // helper is called inside main, main is uncalled
    expect(preprocessCode(code)).toBe(code + '\nreturn await main();');
  });

  it('wraps last expression when function is defined and called as last expr', () => {
    const code = 'function main() { return 1; }\nmain()';
    expect(preprocessCode(code)).toBe('function main() { return 1; }\nreturn (main())');
  });

  it('returns empty code unchanged', () => {
    expect(preprocessCode('')).toBe('');
  });

  it('throws on parse error with line info', () => {
    const code = 'const x = {{{';
    expect(() => preprocessCode(code)).toThrow(/Unexpected token/);
  });

  it('returns code unchanged when last statement is a variable declaration with no functions', () => {
    const code = 'const x = 42';
    expect(preprocessCode(code)).toBe(code);
  });

  it('handles code with only comments', () => {
    const code = '// just a comment';
    expect(preprocessCode(code)).toBe(code);
  });

  it('handles expression with trailing semicolon', () => {
    expect(preprocessCode('foo();')).toBe('return (foo())');
  });

  it('handles function declaration followed by call with semicolon', () => {
    const code = 'async function main() {\n  return 42;\n}\nmain();';
    expect(preprocessCode(code)).toBe('async function main() {\n  return 42;\n}\nreturn (main())');
  });

  it('IIFE-wraps async arrow with block body', () => {
    const code = 'async () => {\n  return await fn();\n}';
    expect(preprocessCode(code)).toBe('return await (async () => {\n  return await fn();\n})()');
  });

  it('IIFE-wraps async arrow with expression body', () => {
    expect(preprocessCode('async () => await fn()')).toBe('return await (async () => await fn())()');
  });

  it('IIFE-wraps sync arrow with block body', () => {
    const code = '() => {\n  return 42;\n}';
    expect(preprocessCode(code)).toBe('return await (() => {\n  return 42;\n})()');
  });

  it('IIFE-wraps function expression', () => {
    const code = '(async function() {\n  return await fn();\n})';
    expect(preprocessCode(code)).toBe('return await (async function() {\n  return await fn();\n})()');
  });

  it('does not IIFE-wrap arrow with parameters', () => {
    expect(preprocessCode('(x) => x + 1')).toBe('return ((x) => x + 1)');
  });

  it('IIFE-wraps real LLM pattern with multi-statement block', () => {
    const code = 'async () => {\n  const count = await getUniquePostsCount();\n  return { count: count };\n}';
    expect(preprocessCode(code)).toBe(
      'return await (async () => {\n  const count = await getUniquePostsCount();\n  return { count: count };\n})()',
    );
  });

  it('handles mixed helper + main pattern from real LLM output', () => {
    const code = `async function helper(id) {
  return await getItem(id);
}

async function main() {
  const items = await listItems();
  const results = [];
  for (const item of items) {
    results.push(await helper(item.id));
  }
  return results;
}`;
    // helper is called inside main, main is uncalled
    expect(preprocessCode(code)).toBe(code + '\nreturn await main();');
  });
});
