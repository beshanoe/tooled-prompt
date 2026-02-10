import { describe, it, expect } from 'vitest';
import {
  isZodSchema,
  isSimpleSchema,
  simpleSchemaToJsonSchema,
  createSimpleSchemaParser,
  resolveSchema,
  TOOL_SYMBOL,
} from '../types.js';
import { z } from 'zod';

describe('isZodSchema', () => {
  it('returns true for Zod schemas', () => {
    expect(isZodSchema(z.string())).toBe(true);
    expect(isZodSchema(z.number())).toBe(true);
    expect(isZodSchema(z.object({ foo: z.string() }))).toBe(true);
    expect(isZodSchema(z.tuple([z.string(), z.number()]))).toBe(true);
    expect(isZodSchema(z.array(z.string()))).toBe(true);
  });

  it('returns false for non-Zod values', () => {
    expect(isZodSchema(null)).toBe(false);
    expect(isZodSchema(undefined)).toBe(false);
    expect(isZodSchema('string')).toBe(false);
    expect(isZodSchema(123)).toBe(false);
    expect(isZodSchema({})).toBe(false);
    expect(isZodSchema({ foo: 'bar' })).toBe(false);
    expect(isZodSchema(['a', 'b'])).toBe(false);
    expect(isZodSchema(() => {})).toBe(false);
  });
});

describe('isSimpleSchema', () => {
  it('returns true for valid SimpleSchemas', () => {
    expect(isSimpleSchema({ foo: 'description' })).toBe(true);
    expect(isSimpleSchema({ foo: 'desc', bar: 'other' })).toBe(true);
    expect(isSimpleSchema({ 'optional?': 'optional field' })).toBe(true);
  });

  it('returns false for invalid values', () => {
    expect(isSimpleSchema(null)).toBe(false);
    expect(isSimpleSchema(undefined)).toBe(false);
    expect(isSimpleSchema('string')).toBe(false);
    expect(isSimpleSchema(123)).toBe(false);
    expect(isSimpleSchema([])).toBe(false);
    expect(isSimpleSchema(['a', 'b'])).toBe(false);
    expect(isSimpleSchema({})).toBe(false); // Empty object
    expect(isSimpleSchema({ foo: 123 })).toBe(false); // Non-string value
    expect(isSimpleSchema({ foo: null })).toBe(false);
    expect(isSimpleSchema({ foo: { nested: 'value' } })).toBe(false);
  });
});

describe('simpleSchemaToJsonSchema', () => {
  it('converts simple schema to JSON Schema', () => {
    const simple = { name: 'User name', email: 'User email' };
    const jsonSchema = simpleSchemaToJsonSchema(simple);

    expect(jsonSchema.type).toBe('object');
    expect(jsonSchema.properties.name).toEqual({ type: 'string', description: 'User name' });
    expect(jsonSchema.properties.email).toEqual({ type: 'string', description: 'User email' });
    expect(jsonSchema.required).toEqual(['name', 'email']);
  });

  it('handles optional fields with ? suffix', () => {
    const simple = { required: 'Required field', 'optional?': 'Optional field' };
    const jsonSchema = simpleSchemaToJsonSchema(simple);

    expect(jsonSchema.properties.required).toEqual({ type: 'string', description: 'Required field' });
    expect(jsonSchema.properties.optional).toEqual({ type: 'string', description: 'Optional field' });
    expect(jsonSchema.required).toEqual(['required']);
  });

  it('omits required when all fields are optional', () => {
    const simple = { 'a?': 'Field A', 'b?': 'Field B' };
    const jsonSchema = simpleSchemaToJsonSchema(simple);

    expect(jsonSchema.required).toBeUndefined();
  });
});

describe('createSimpleSchemaParser', () => {
  it('accepts valid data matching schema', () => {
    const parse = createSimpleSchemaParser({
      name: 'User name',
      email: 'User email',
    });

    const validData = { name: 'John Doe', email: 'john@example.com' };
    const result = parse(validData);

    expect(result).toEqual(validData);
  });

  it('rejects data with missing required fields', () => {
    const parse = createSimpleSchemaParser({
      name: 'User name',
      email: 'User email',
    });

    expect(() => parse({ name: 'John' })).toThrow('Missing required field: "email"');
  });

  it('rejects data with wrong types', () => {
    const parse = createSimpleSchemaParser({ name: 'User name' });

    expect(() => parse({ name: 12345 })).toThrow('Field "name" must be a string');
  });

  it('rejects null and undefined for required fields', () => {
    const parse = createSimpleSchemaParser({ name: 'User name' });

    expect(() => parse({ name: null })).toThrow('Missing required field: "name"');
    expect(() => parse({ name: undefined })).toThrow('Missing required field: "name"');
  });

  it('accepts missing optional fields', () => {
    const parse = createSimpleSchemaParser({
      required: 'Required',
      'optional?': 'Optional',
    });

    const result = parse({ required: 'value' });
    expect(result).toEqual({ required: 'value' });
  });

  it('accepts empty strings (they are valid strings)', () => {
    const parse = createSimpleSchemaParser({ name: 'User name' });

    const result = parse({ name: '' });
    expect(result).toEqual({ name: '' });
  });

  it('preserves data through parsing', () => {
    const parse = createSimpleSchemaParser({
      name: 'User name',
      'bio?': 'Bio',
    });

    const input = { name: 'Alice', bio: 'Software engineer' };
    const result = parse(input);

    expect(result.name).toBe('Alice');
    expect(result.bio).toBe('Software engineer');
  });

  it('handles multiple optional fields correctly', () => {
    const parse = createSimpleSchemaParser({
      'a?': 'Field A',
      'b?': 'Field B',
      'c?': 'Field C',
    });

    // All missing - should pass (empty object)
    expect(parse({})).toEqual({});

    // Some present - should pass
    expect(parse({ a: 'value' })).toEqual({ a: 'value' });
    expect(parse({ b: 'value', c: 'value' })).toEqual({ b: 'value', c: 'value' });

    // All present - should pass
    expect(parse({ a: '1', b: '2', c: '3' })).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('rejects non-object input', () => {
    const parse = createSimpleSchemaParser({ name: 'User name' });

    expect(() => parse(null)).toThrow('Expected an object');
    expect(() => parse('string')).toThrow('Expected an object');
    expect(() => parse([])).toThrow('Expected an object');
  });
});

describe('resolveSchema', () => {
  it('resolves ZodType to ResolvedSchema', () => {
    const zodSchema = z.object({ name: z.string(), age: z.number() });
    const resolved = resolveSchema(zodSchema);

    expect(resolved.jsonSchema).toBeDefined();
    expect((resolved.jsonSchema as any).properties.name).toBeDefined();
    expect(resolved.parse({ name: 'John', age: 30 })).toEqual({ name: 'John', age: 30 });
  });

  it('resolves SimpleSchema to ResolvedSchema', () => {
    const simple = { name: 'User name', 'bio?': 'Bio' };
    const resolved = resolveSchema(simple);

    expect((resolved.jsonSchema as any).type).toBe('object');
    expect((resolved.jsonSchema as any).properties.name).toEqual({ type: 'string', description: 'User name' });
    expect(resolved.parse({ name: 'Alice' })).toEqual({ name: 'Alice' });
  });
});

describe('TOOL_SYMBOL', () => {
  it('uses tooled-prompt namespace', () => {
    expect(TOOL_SYMBOL).toBe(Symbol.for('tooled-prompt.tool'));
  });

  it('is consistent across imports', () => {
    const symbol1 = Symbol.for('tooled-prompt.tool');
    const symbol2 = Symbol.for('tooled-prompt.tool');
    expect(symbol1).toBe(symbol2);
    expect(TOOL_SYMBOL).toBe(symbol1);
  });
});
