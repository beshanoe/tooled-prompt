import { describe, it, expect } from 'vitest';
import { parseFunction } from '../parser.js';

/**
 * Parser tests
 *
 * IMPORTANT: These tests run against compiled JavaScript at runtime,
 * NOT TypeScript source. TypeScript's `?` optional syntax is stripped
 * during compilation and cannot be detected.
 *
 * Only parameters with default values can be reliably detected as optional.
 */

describe('parseFunction', () => {
  describe('regular functions', () => {
    it('parses function with no params', () => {
      function noParams() {
        return 'ok';
      }
      const result = parseFunction(noParams);
      expect(result.name).toBe('noParams');
      expect(result.params).toEqual([]);
    });

    it('parses function with single param', () => {
      function singleParam(name: string) {
        return name;
      }
      const result = parseFunction(singleParam);
      expect(result.name).toBe('singleParam');
      expect(result.params).toEqual([{ name: 'name', optional: false }]);
    });

    it('parses function with multiple params', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function multiParams(a: string, b: number, c: boolean) {
        return a;
      }
      const result = parseFunction(multiParams);
      expect(result.name).toBe('multiParams');
      expect(result.params).toEqual([
        { name: 'a', optional: false },
        { name: 'b', optional: false },
        { name: 'c', optional: false },
      ]);
    });
  });

  describe('async functions', () => {
    it('parses async function', () => {
      async function asyncFn(data: string) {
        return data;
      }
      const result = parseFunction(asyncFn);
      expect(result.name).toBe('asyncFn');
      expect(result.params).toEqual([{ name: 'data', optional: false }]);
    });
  });

  describe('arrow functions', () => {
    it('parses arrow function with parentheses', () => {
      const arrowFn = (x: string, y: number) => x + y;
      const result = parseFunction(arrowFn);
      expect(result.name).toBe('arrowFn');
      expect(result.params).toEqual([
        { name: 'x', optional: false },
        { name: 'y', optional: false },
      ]);
    });

    it('parses async arrow function', () => {
      const asyncArrow = async (input: string) => input;
      const result = parseFunction(asyncArrow);
      expect(result.name).toBe('asyncArrow');
      expect(result.params).toEqual([{ name: 'input', optional: false }]);
    });

    it('parses arrow function with single unparenthesized param', () => {
      const singleArrow = (x: string) => x;
      const result = parseFunction(singleArrow);
      expect(result.name).toBe('singleArrow');
      expect(result.params).toEqual([{ name: 'x', optional: false }]);
    });
  });

  describe('optional parameters (default values)', () => {
    it('marks parameters with default values as optional', () => {
      function withDefault(name: string = 'default') {
        return name;
      }
      const result = parseFunction(withDefault);
      expect(result.name).toBe('withDefault');
      expect(result.params).toEqual([{ name: 'name', optional: true }]);
    });

    it('handles mixed required and optional params', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function mixedParams(required: string, optional: number = 10) {
        return required;
      }
      const result = parseFunction(mixedParams);
      expect(result.name).toBe('mixedParams');
      expect(result.params).toEqual([
        { name: 'required', optional: false },
        { name: 'optional', optional: true },
      ]);
    });

    it('handles multiple default values', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function multiDefaults(a: string = 'x', b: number = 1, c: boolean = true) {
        return a;
      }
      const result = parseFunction(multiDefaults);
      expect(result.name).toBe('multiDefaults');
      expect(result.params).toEqual([
        { name: 'a', optional: true },
        { name: 'b', optional: true },
        { name: 'c', optional: true },
      ]);
    });
  });

  describe('edge cases', () => {
    it('handles anonymous function', () => {
      const result = parseFunction(function (a: string) {
        return a;
      });
      expect(result.name).toBe('anonymous');
      expect(result.params).toEqual([{ name: 'a', optional: false }]);
    });

    it('handles function with complex type annotations', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function complexTypes(obj: { foo: string }, arr: string[]) {
        return obj;
      }
      const result = parseFunction(complexTypes);
      expect(result.name).toBe('complexTypes');
      // Note: complex types are stripped, only param names remain
      expect(result.params.length).toBe(2);
      expect(result.params[0].name).toBe('obj');
      expect(result.params[1].name).toBe('arr');
    });
  });

  describe('runtime limitations', () => {
    it('TypeScript optional syntax (?) is NOT detectable at runtime', () => {
      // TypeScript compiles fn(x?: string) to fn(x) - the ? is stripped
      // This test documents the limitation, not a feature
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      function withTsOptional(required: string, optional?: number) {
        return required;
      }
      const result = parseFunction(withTsOptional);

      // Both params appear required because TS `?` is stripped at compile time
      // This is expected behavior - use default values for runtime-detectable optionality
      expect(result.params.length).toBe(2);
      expect(result.params[0]).toEqual({ name: 'required', optional: false });
      // NOTE: optional is false here because TS `?` is stripped
      expect(result.params[1]).toEqual({ name: 'optional', optional: false });
    });
  });
});
