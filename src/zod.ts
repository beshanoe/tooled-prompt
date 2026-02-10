/**
 * Lazy Zod loader — defers import so the package loads without Zod installed.
 *
 * Top-level `await import()` is supported by ES2022 + NodeNext (tsconfig) and Node >= 20 (engines).
 * Chosen over `createRequire` to avoid loading a separate CJS copy with a different
 * `z.globalRegistry` instance.
 */

let _z: any;
try {
  const mod = await import('zod');
  _z = mod.z ?? mod.default;
} catch {
  // zod is an optional peer dependency — silently ignore if not installed
}

export function requireZod() {
  if (!_z) throw new Error('This feature requires "zod" (>= 4.0.0). Install: npm install zod');
  return _z;
}
