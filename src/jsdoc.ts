/**
 * JSDoc rendering for JSON Schema.
 *
 * Pure schema-to-string primitives used to describe tools to an LLM.
 * Input is a JSON Schema node (however produced — Zod, hand-written, etc.);
 * output is either a compact inline TS-like type string or a set of
 * JSDoc `@param` / `@returns` lines with dotted-path expansion for nested
 * objects that carry per-field descriptions.
 *
 * This module knows nothing about tool metadata, AsyncFunction, or the
 * rest of the library — it is a renderer, nothing more.
 */

export type Schema = Record<string, unknown>;
export type JsDocTag = 'param' | 'returns' | 'property';

// ---------------------------------------------------------------------------
// Description extraction
// ---------------------------------------------------------------------------

/**
 * Pull a human-readable description from a JSON Schema node.
 *
 * Falls back to the non-null variant of an `anyOf`/`oneOf` union, so
 * `z.x().describe(...).nullable()` — which Zod emits as
 * `{anyOf: [{…, description}, {type: 'null'}]}` — still surfaces its
 * description.
 */
export function getInlineDescription(schema: Schema): string | undefined {
  if (typeof schema.description === 'string') return schema.description;
  const union = (schema.anyOf || schema.oneOf) as Schema[] | undefined;
  if (union) {
    const nonNull = union.find((s) => s.type !== 'null');
    if (nonNull && typeof nonNull.description === 'string') return nonNull.description;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Inline type-string rendering
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema to a compact TS-like type string.
 * e.g. `{type: "object", properties: {name: {type: "string"}, id: {type: "number"}}}`
 *   → `"{ name: string, id: number }"`
 *
 * Unions (`anyOf`/`oneOf`) render as `A | B`. Per-field descriptions are NOT
 * emitted here — JSDoc's inline type grammar has no slot for them. Nested
 * field descriptions are surfaced separately via `expandDottedLines`.
 */
export function jsonSchemaToTypeString(schema: Schema): string {
  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues) return enumValues.map((v) => JSON.stringify(v)).join(' | ');

  const union = (schema.anyOf || schema.oneOf) as Schema[] | undefined;
  if (union) return union.map(jsonSchemaToTypeString).join(' | ');

  const type = schema.type as string | undefined;
  if (type === 'string') return 'string';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'null') return 'null';
  if (type === 'array') {
    const items = schema.items as Schema | undefined;
    return items ? `${jsonSchemaToTypeString(items)}[]` : 'unknown[]';
  }
  if (type === 'object' && schema.properties) {
    const props = schema.properties as Record<string, Schema>;
    const req = new Set((schema.required as string[]) || []);
    const fields = Object.entries(props)
      .map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${jsonSchemaToTypeString(v)}`)
      .join(', ');
    return `{ ${fields} }`;
  }
  return 'object';
}

// ---------------------------------------------------------------------------
// Schema shape helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a nullable schema (Zod emits `.nullable()` as an `anyOf` of the
 * real schema + `{type: 'null'}`). Returns the non-null branch, or the
 * schema unchanged when it isn't a nullable union.
 */
function unwrapNullable(schema: Schema): Schema {
  const union = (schema.anyOf || schema.oneOf) as Schema[] | undefined;
  if (!union) return schema;
  const nonNull = union.filter((s) => s.type !== 'null');
  return nonNull.length === 1 ? nonNull[0] : schema;
}

/**
 * Unwrap an array schema to `{inner, suffix}`. For `T[]`, returns the element
 * schema with `"[]"`; for non-arrays, returns the schema with `""`.
 */
function unwrapArray(schema: Schema): { inner: Schema; suffix: string } {
  const unwrapped = unwrapNullable(schema);
  if (unwrapped.type === 'array' && unwrapped.items) {
    return { inner: unwrapped.items as Schema, suffix: '[]' };
  }
  return { inner: unwrapped, suffix: '' };
}

/**
 * True when the schema (possibly nullable, possibly array-of) is an object
 * whose properties carry descriptions worth expanding into dotted JSDoc.
 * Without descriptions there's nothing to gain over the inline type.
 */
function shouldExpand(schema: Schema): boolean {
  const { inner } = unwrapArray(schema);
  if (inner.type !== 'object' || !inner.properties) return false;
  return hasAnyDescription(inner);
}

function hasAnyDescription(schema: Schema): boolean {
  const props = schema.properties as Record<string, Schema> | undefined;
  if (!props) return false;
  for (const prop of Object.values(props)) {
    if (getInlineDescription(prop) || hasAnyDescription(unwrapArray(prop).inner)) return true;
  }
  return false;
}

/** `Object` or `Object[]` — the placeholder shown before a dotted expansion. */
function containerTypeString(schema: Schema): string {
  return unwrapArray(schema).suffix === '[]' ? 'Object[]' : 'Object';
}

function cleanDescription(desc: string | undefined): string {
  return desc ? desc.replace(/\s+/g, ' ').trim() : '';
}

/** Compact inline type, or an `Object`/`Object[]` placeholder when we're going to expand. */
function typeFor(schema: Schema): string {
  return shouldExpand(schema) ? containerTypeString(schema) : jsonSchemaToTypeString(schema);
}

// ---------------------------------------------------------------------------
// Line rendering
// ---------------------------------------------------------------------------

/** `" * @tag body[separator desc]"`, with `desc` cleaned and omitted when empty. */
function headerLine(tag: JsDocTag, body: string, desc: string | undefined, separator = ' - '): string {
  const clean = cleanDescription(desc);
  return ` * @${tag} ${body}${clean ? `${separator}${clean}` : ''}`;
}

/**
 * Render a `@param` tag as a header line plus any dotted expansion lines.
 *
 * Header:   ` * @param {Type} name - desc`  (or `[name]` when optional)
 * Expanded: ` * @param {Type} name.field - desc` for each nested property.
 *
 * When `refs` is provided and the schema (possibly wrapped in array/nullable)
 * matches a registered typedef, the header collapses to `{TypedefName}` and
 * no dotted expansion is emitted.
 */
export function renderParam(name: string, schema: Schema, optional: boolean, refs?: Map<string, string>): string[] {
  const display = optional ? `[${name}]` : name;
  const refName = refs ? refLookup(schema, refs) : undefined;
  if (refName) {
    return [headerLine('param', `{${refName}} ${display}`, getInlineDescription(schema))];
  }
  return [
    headerLine('param', `{${typeFor(schema)}} ${display}`, getInlineDescription(schema)),
    ...expandDottedLines('param', name, schema, refs),
  ];
}

/**
 * Render a `@returns` tag. Unlike `@param`, the header carries no label —
 * JSDoc convention is `@returns {Type} description`. Expansion still uses
 * a synthetic `returns` prefix so sub-fields are addressable.
 *
 * `schema` may be undefined when the caller has a description but no schema;
 * in that case the returned line is just `@returns DESC`.
 *
 * When `refs` contains the schema, the tag collapses to `{TypedefName}` and
 * no dotted expansion is emitted. In practice `collectTypedefs` always
 * promotes object return schemas so this is the expected path for objects.
 */
export function renderReturns(schema: Schema | undefined, desc: string, refs?: Map<string, string>): string[] {
  if (!schema) return [` * @returns ${desc}`.trimEnd()];
  const refName = refs ? refLookup(schema, refs) : undefined;
  if (refName) {
    return [headerLine('returns', `{${refName}}`, desc, ' ')];
  }
  return [
    headerLine('returns', `{${typeFor(schema)}}`, desc, ' '),
    ...expandDottedLines('returns', 'returns', schema, refs),
  ];
}

/**
 * Flatten an object (or array-of-object) schema into dotted JSDoc lines,
 * e.g. `@param {string} opts.name - desc` or `@returns {number} returns[].id`.
 * Returns an empty array when there's nothing worth expanding.
 *
 * When `refs` is provided, any nested field whose schema matches a typedef
 * renders as `{TypedefName}` and is not recursed into.
 */
function expandDottedLines(tag: JsDocTag, prefix: string, schema: Schema, refs?: Map<string, string>): string[] {
  if (!shouldExpand(schema)) return [];
  const { inner, suffix } = unwrapArray(schema);
  const props = inner.properties as Record<string, Schema>;
  const required = new Set((inner.required as string[]) || []);

  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const path = `${prefix}${suffix}.${name}`;
    const optional = !required.has(name);
    const display = tag === 'param' && optional ? `[${path}]` : path;
    const refName = refs ? refLookup(prop, refs) : undefined;
    if (refName) {
      lines.push(headerLine(tag, `{${refName}} ${display}`, getInlineDescription(prop)));
      continue;
    }
    lines.push(headerLine(tag, `{${typeFor(prop)}} ${display}`, getInlineDescription(prop)));
    lines.push(...expandDottedLines(tag, path, prop, refs));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Typedef collection + rendering
// ---------------------------------------------------------------------------

export interface Typedef {
  name: string;
  schema: Schema;
}

export interface TypedefSource {
  /** Top-level schemas for each named parameter. */
  paramSchemas: Schema[];
  /** Return schema, if any. */
  returnSchema?: Schema;
}

export interface TypedefContext {
  typedefs: Typedef[];
  /** structural hash → typedef name */
  refs: Map<string, string>;
}

/**
 * Stable JSON stringify — sorts object keys so two structurally identical
 * schemas always produce the same hash regardless of key insertion order.
 *
 * Skips JSON Schema meta keys (`$schema`, `$id`, `$defs`, `$ref`,
 * `additionalProperties`) which Zod emits on the top-level schema but not on
 * the same shape when it appears nested. Without this, a shape used once as a
 * top-level return and once as an array element would fail to dedup.
 */
const HASH_SKIP_KEYS = new Set(['$schema', '$id', '$defs', '$ref', 'additionalProperties']);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => !HASH_SKIP_KEYS.has(k))
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function schemaHash(schema: Schema): string {
  return stableStringify(schema);
}

/**
 * Yield every object schema under `schema` (plus `schema` itself) that has
 * described nested fields — i.e. shapes that would otherwise require dotted
 * expansion. Unwraps array/nullable wrappers so the yielded node is always
 * the bare `{type:'object', properties:{...}}`.
 */
function* walkPromotable(schema: Schema): Generator<Schema> {
  if (!schema || typeof schema !== 'object') return;
  const { inner } = unwrapArray(schema);
  if (shouldExpand(schema)) yield inner;
  if (inner.properties) {
    for (const prop of Object.values(inner.properties as Record<string, Schema>)) {
      yield* walkPromotable(prop);
    }
  }
  const union = (inner.anyOf || inner.oneOf) as Schema[] | undefined;
  if (union) for (const s of union) yield* walkPromotable(s);
}

/**
 * Total number of dotted lines `expandDottedLines` would emit for this shape,
 * including all nested expansions. Used as a rough proxy for "how much
 * dotted-form noise does this shape contribute".
 */
function expandableLineCount(schema: Schema): number {
  if (!shouldExpand(schema)) return 0;
  const { inner } = unwrapArray(schema);
  const props = inner.properties as Record<string, Schema>;
  let count = 0;
  for (const prop of Object.values(props)) {
    count++;
    count += expandableLineCount(prop);
  }
  return count;
}

/**
 * Minimum expandable-line count before a single-use, non-return shape is
 * promoted. Below this, the typedef header + reference line cost roughly
 * equals the savings from dropping the `prefix.` repetition, so inline
 * dotted expansion is equally terse (and more conventional).
 *
 * At 4+ lines, the typedef form wins meaningfully — the bigger the shape,
 * the bigger the win, because every expanded line drops its `prefix.` cost.
 */
const SINGLE_USE_PROMOTE_THRESHOLD = 4;

/**
 * Collect object shapes worth promoting to `@typedef` blocks.
 *
 * Promotion rule: a shape is promoted when ANY of:
 *   1. It appears structurally ≥2 times across the tool set (dedup win).
 *   2. It is (reachable from) a return schema (dotted `@returns.field` is
 *      non-standard JSDoc, whereas typedefs are).
 *   3. Its dotted expansion would produce ≥ SINGLE_USE_PROMOTE_THRESHOLD
 *      lines — at which point the typedef form is shorter than repeating
 *      the `prefix.` on every line.
 *
 * Returns the typedef list (in first-encounter order) and a hash→name lookup
 * map for use during rendering.
 */
export function collectTypedefs(sources: TypedefSource[]): TypedefContext {
  const entries = new Map<string, { schema: Schema; count: number; isReturn: boolean; lines: number }>();

  const register = (schema: Schema | undefined, isReturn: boolean) => {
    if (!schema) return;
    for (const sub of walkPromotable(schema)) {
      const h = schemaHash(sub);
      const existing = entries.get(h);
      if (existing) {
        existing.count++;
        if (isReturn) existing.isReturn = true;
      } else {
        entries.set(h, { schema: sub, count: 1, isReturn, lines: expandableLineCount(sub) });
      }
    }
  };

  for (const source of sources) {
    for (const p of source.paramSchemas) register(p, false);
    register(source.returnSchema, true);
  }

  const refs = new Map<string, string>();
  const typedefs: Typedef[] = [];
  let counter = 0;
  for (const [hash, entry] of entries) {
    const shouldPromote = entry.count >= 2 || entry.isReturn || entry.lines >= SINGLE_USE_PROMOTE_THRESHOLD;
    if (!shouldPromote) continue;
    counter++;
    const name = `T${counter}`;
    refs.set(hash, name);
    typedefs.push({ name, schema: entry.schema });
  }
  return { typedefs, refs };
}

/**
 * Look up a typedef name for `schema`, preserving array/nullable wrappers.
 * Returns `T1`, `T1[]`, `T1 | null`, `T1[] | null`, or undefined if no match.
 *
 * Only matches when the schema unwraps to an object node with `properties`;
 * other shapes (primitives, unions of non-object types) fall through.
 */
function refLookup(schema: Schema, refs: Map<string, string>): string | undefined {
  const { inner, suffix } = unwrapArray(schema);
  if (inner.type !== 'object' || !inner.properties) return undefined;
  const name = refs.get(schemaHash(inner));
  if (!name) return undefined;
  const union = (schema.anyOf || schema.oneOf) as Schema[] | undefined;
  const nullSuffix = union?.some((s) => s.type === 'null') ? ' | null' : '';
  return `${name}${suffix}${nullSuffix}`;
}

/**
 * Render a `@typedef {Object} name` block with one `@property` line per field.
 *
 * Fields whose schema matches another typedef collapse to `{RefName}`; other
 * nested object fields still dot-expand (`field.subfield`), which is canonical
 * JSDoc for nested properties inside a typedef.
 */
export function renderTypedef(name: string, schema: Schema, refs?: Map<string, string>): string[] {
  const { inner } = unwrapArray(schema);
  const props = (inner.properties || {}) as Record<string, Schema>;
  const required = new Set((inner.required as string[]) || []);

  const lines: string[] = [` * @typedef {Object} ${name}`];
  for (const [field, prop] of Object.entries(props)) {
    const optional = !required.has(field);
    const display = optional ? `[${field}]` : field;
    const refName = refs ? refLookup(prop, refs) : undefined;
    if (refName) {
      lines.push(headerLine('property', `{${refName}} ${display}`, getInlineDescription(prop)));
      continue;
    }
    lines.push(headerLine('property', `{${typeFor(prop)}} ${display}`, getInlineDescription(prop)));
    lines.push(...expandDottedLines('property', field, prop, refs));
  }
  return lines;
}
