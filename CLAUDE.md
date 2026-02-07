# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run typecheck                          # Type-check (includes type-level tests in src/__tests__/tool.test-types.ts)
npm test                                   # Run all runtime tests
npm test -- src/__tests__/tool.test.ts     # Run a single test file
npx tsx examples/weather.ts                # Run an example
```

No lint/formatter configured. Type checking via `strict: true` in tsconfig is the primary code quality gate.

## Architecture

**tooled-prompt** is a zero-dependency runtime LLM prompt library. Functions embedded in tagged template literals are auto-detected as tools the LLM can call.

### Core flow

```
prompt`Use ${myFunc} to ...`()
  → factory.ts: extracts tools from template values, auto-wraps plain functions
  → executor.ts buildPromptText(): replaces tool refs with 'the "name" tool'
  → executor.ts runToolLoop(): sends to LLM, executes tool calls, loops until done
```

### Module responsibilities

- **`factory.ts`** — `createTooledPrompt()` returns isolated instances with layered config (per-call > setConfig > factory > defaults). Default LLM URL: `http://localhost:8080/v1`.
- **`executor.ts`** — LLM communication (fetch), SSE streaming parser, tool call dispatch. Converts tool metadata to OpenAI function-calling format. Dispatches tool args positionally by matching JSON keys to `parameters.properties` key order.
- **`tool.ts`** — `tool()` wraps functions with JSON Schema metadata stored at `fn[TOOL_SYMBOL]`. Schema generated from `args` array or auto-inferred via parser.
- **`parser.ts`** — Regex-based runtime function introspection (`fn.toString()`). Extracts param names and optionality. **Key limitation**: TypeScript `?` is stripped at compile time; only default values (`= val`) are detectable as optional at runtime.
- **`events.ts`** — Typed event emitter for content, thinking, tool_call, tool_result, tool_error.
- **`types.ts`** — Shared types. `SimpleSchema` / `isSimpleSchema` / `simpleSchemaToZod` are used only by structured output in `factory.ts`, not by tool args.

### tool() args system

`args` is always an array. Each element is one of three descriptor types:

| Descriptor | Example | Name source |
|---|---|---|
| `string` | `'City name'` | Parsed function param name |
| `[string, string]` | `['city', 'City name']` | Explicit first element |
| `ZodType` | `z.string().describe('City')` | `z.globalRegistry` `.name` or parsed param |

String/tuple descriptors produce `{ type: 'string' }` schemas. Zod descriptors use `z.toJSONSchema()` for rich types. Optionality comes from the parsed function (default values), not from the descriptor.

### Type system

`ArgsForFn<T>` maps a function's `Parameters<T>` to `ArgDescriptorTuple` — a recursive conditional type that enforces arity and Zod output type matching at compile time. Optional params (trailing `?` in the tuple) allow omitting trailing descriptors.

### Tests

- `src/__tests__/*.test.ts` — Runtime tests (vitest). `executor.test.ts` mocks `globalThis.fetch`.
- `src/__tests__/tool.test-types.ts` — Type-level tests validated by `tsc --noEmit`, excluded from vitest. Uses `@ts-expect-error` for negative cases.

### vi.fn() gotcha

When wrapping `vi.fn()` spies with `tool({ name }, ...)`, the parser sees the spy wrapper's toString, not the original function. Use `[name, desc]` tuple descriptors to provide explicit param names in tests.
