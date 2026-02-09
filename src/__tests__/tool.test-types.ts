/**
 * Type-level tests for tool() args generics
 *
 * Run: npm run typecheck
 * All @ts-expect-error lines should produce errors; others should compile.
 */
import { tool } from '../index.js';
import { z } from 'zod';

// === 0 args ===
function noArgs() {
  return 'ok';
}
tool(noArgs); // ✓
tool(noArgs, { description: 'desc' }); // ✓
// @ts-expect-error - no args means no args option
tool(noArgs, { args: ['wrong'] });
// @ts-expect-error - no args means no args option
tool(noArgs, { args: 'wrong' });

// === 1 arg ===
function oneArg(city: string) {
  return city;
}
tool(oneArg); // ✓
tool(oneArg, { args: ['city desc'] }); // ✓ string descriptor
tool(oneArg, { args: [['city', 'desc']] }); // ✓ tuple descriptor
tool(oneArg, { args: [z.string()] }); // ✓ zod descriptor
// @ts-expect-error - plain string not allowed (must be array)
tool(oneArg, { args: 'city desc' });
// @ts-expect-error - object not allowed (must be array)
tool(oneArg, { args: { city: 'desc' } });
// @ts-expect-error - z.object output doesn't match string param
tool(oneArg, { args: [z.object({ city: z.string() })] });
// @ts-expect-error - wrong arity
tool(oneArg, { args: [z.string(), z.string()] });
// @ts-expect-error - wrong arity
tool(oneArg, { args: ['a', 'b'] });

// === 2 args ===
function twoArgs(src: string, dest: string) {
  return src + dest;
}
tool(twoArgs); // ✓
tool(twoArgs, { args: ['src', 'dest'] }); // ✓ string descriptors
tool(twoArgs, { args: [['source', 'Source path'], ['dest', 'Dest path']] }); // ✓ tuple descriptors
tool(twoArgs, { args: [z.string(), z.string()] }); // ✓ zod descriptors
tool(twoArgs, { args: ['Source path', z.string().describe('Destination')] }); // ✓ mixed
tool(twoArgs, { args: [['src', 'Source path'], z.string()] }); // ✓ mixed tuple + zod
// @ts-expect-error - wrong arity (too few)
tool(twoArgs, { args: ['single'] });
// @ts-expect-error - wrong arity (too many)
tool(twoArgs, { args: ['a', 'b', 'c'] });
// @ts-expect-error - plain string not allowed for multi-arg
tool(twoArgs, { args: 'wrong' });
// @ts-expect-error - object not allowed
tool(twoArgs, { args: { src: 'd', dest: 'd' } });

// === 3 args ===
function threeArgs(a: string, b: string, c: string) {
  return a;
}
tool(threeArgs, { args: ['a', 'b', 'c'] }); // ✓
// @ts-expect-error - wrong arity
tool(threeArgs, { args: ['a', 'b'] });

// === Object syntax ===
const arrowFn = (x: string) => x.toUpperCase();
tool({ arrowFn }, { args: ['desc'] }); // ✓
tool({ arrowFn }, { args: [['x', 'desc']] }); // ✓ tuple
// @ts-expect-error - plain string not allowed
tool({ arrowFn }, { args: 'desc' });
// @ts-expect-error - wrong arity
tool({ arrowFn }, { args: ['a', 'b'] });

// === Zod array for typed positional args ===
function typedArgs(name: string, age: number) {
  return `${name} is ${age}`;
}
tool(typedArgs, { args: [z.string(), z.number()] }); // ✓

// Zod array with single arg
function singleTyped(x: number) {
  return x * 2;
}
tool(singleTyped, { args: [z.number()] }); // ✓

// Zod array with descriptions
function describedArgs(src: string, dest: string) {
  return `${src} -> ${dest}`;
}
tool(describedArgs, {
  args: [z.string().describe('Source path'), z.string().describe('Destination path')],
}); // ✓

// Zod array in object syntax
const typedArrow = (a: string, b: number) => a.repeat(b);
tool({ typedArrow }, { args: [z.string(), z.number()] }); // ✓

// Zod array with optional params (? syntax)
function withOptional(required: string, optional?: number) {
  return required + (optional ?? 0);
}
tool(withOptional, { args: [z.string()] }); // ✓ - matches required only
tool(withOptional, { args: [z.string(), z.number()] }); // ✓ - matches both

// Default value params — same optionality as ?
function withDefault(name: string, unit = 'fahrenheit') {
  return `${name} (${unit})`;
}
tool(withDefault, { args: ['Name'] }); // ✓ - omit optional
tool(withDefault, { args: ['Name', 'Unit'] }); // ✓ - provide both strings
tool(withDefault, { args: [['name', 'Name'], ['unit', 'Unit']] }); // ✓ - provide both tuples
tool(withDefault, { args: [z.string(), z.string()] }); // ✓ - provide both zod
tool(withDefault, { args: ['Name', z.string()] }); // ✓ - mixed

// === z.object element for fn that takes an object param ===
function takesObject(data: { name: string; age: number }) {
  return data.name;
}
tool(takesObject, { args: [z.object({ name: z.string(), age: z.number() })] }); // ✓

// === Mixed descriptors ===
function mixedFn(name: string, count: number) {
  return name.repeat(count);
}
tool(mixedFn, { args: ['The name', z.number().describe('Repeat count')] }); // ✓
tool(mixedFn, { args: [['name', 'The name'], z.number()] }); // ✓

// ============================================================================
// Prompt executor return types
// ============================================================================

import { prompt } from '../index.js';
import type { PromptResult } from '../types.js';

// --- No schema: data is string | undefined ---
{
  const res = await prompt`Hello`();
  // data should be string | undefined
  const data: string | undefined = res.data;
  // @ts-expect-error - data is string | undefined, not number
  const _bad: number = res.data;
}

// --- Zod schema: data matches inferred Zod type ---
{
  const UserSchema = z.object({ name: z.string(), age: z.number() });
  const res = await prompt`Get user`(UserSchema);
  // data should be { name: string; age: number } | undefined
  if (res.data) {
    const name: string = res.data.name;
    const age: number = res.data.age;
    // @ts-expect-error - age is number, not string
    const _badAge: string = res.data.age;
  }
}

// --- SimpleSchema: optional key mapping, all values string ---
{
  const res = await prompt`Summarize`({ summary: 'The summary', 'detail?': 'Optional detail' });
  if (res.data) {
    // summary is required string
    const summary: string = res.data.summary;
    // detail is string (mapped from 'detail?')
    const detail: string = res.data.detail;
    // @ts-expect-error - no key 'detail?' on result (it's mapped to 'detail')
    res.data['detail?'];
    // @ts-expect-error - values are string, not number
    const _bad: number = res.data.summary;
  }
}

// --- Config-only: still returns PromptResult<string> ---
{
  const res = await prompt`Hello`({ temperature: 0.5 });
  const check: PromptResult<string> = res;
  // @ts-expect-error - data is string | undefined, not number
  const _bad: number = res.data;
}
