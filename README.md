# tooled-prompt

[![npm version](https://img.shields.io/npm/v/tooled-prompt.svg)](https://www.npmjs.com/package/tooled-prompt)
[![CI](https://github.com/beshanoe/tooled-prompt/actions/workflows/ci.yml/badge.svg)](https://github.com/beshanoe/tooled-prompt/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Runtime LLM prompt library with smart tool recognition for TypeScript.

## Table of Contents

- [The Problem](#the-problem)
- [The Solution](#the-solution)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Features](#features)
- [Usage](#usage)
  - [Basic Inference](#basic-inference)
  - [Image Support](#image-support)
  - [Multiple Tools](#multiple-tools)
  - [Structured Output](#structured-output)
  - [Store Pattern](#store-pattern)
  - [Adding Descriptions with tool()](#adding-descriptions-with-tool)
  - [Multiple Prompt Instances](#multiple-prompt-instances)
  - [Providers](#providers)
  - [System Prompt](#system-prompt)
- [API Reference](#api-reference)
- [License](#license)

## The Problem

LLM tool calling requires manual JSON schema authoring, tool registration boilerplate, and managing the request/execute/respond loop. Existing libraries add heavy abstractions and framework lock-in.

## The Solution

Tagged template literals are the perfect API for LLM prompts. Functions in `${}` are auto-detected as tools. No boilerplate, no schema authoring, no framework.

## Installation

```bash
npm install tooled-prompt
```

## Quick Start

```typescript
import { prompt, setConfig } from "tooled-prompt";

setConfig({
  apiUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-5-nano"
});

function getWeather(cityName: string) {
  return `Weather in ${cityName}: Sunny, 72°F`;
}

const { data } = await prompt`
  What's the weather like in San Francisco?
  Use ${getWeather} to find out.
`();

console.log(data);
```

> Using Deno? See the [Even Quicker Start](docs/deno.md) guide.

## Features

- **Smart Tool Recognition** — Functions in template literals are auto-detected as tools
- **Multiple Schema Formats** — Define tool args with strings, arrays, or Zod schemas
- **Structured Output** — Get typed responses with Zod schema validation
- **Store Pattern** — Capture structured output via tool calls with `store()` and `prompt.return`
- **Image Support** — Pass images (Buffer/Uint8Array) directly in templates
- **Streaming Events** — Subscribe to content, thinking, and tool events
- **Multi-Provider** — Built-in support for OpenAI, Anthropic, and Ollama
- **Multiple Instances** — Create isolated instances for different LLM providers
- **TypeScript First** — Full type safety with generics

## Usage

### Basic Inference

Functions in template literals are auto-detected as tools. Parameter names and optionality are inferred at runtime — no schema needed:

```typescript
import { prompt, setConfig } from "tooled-prompt";
import * as fs from "fs/promises";

setConfig({
  apiUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-5-nano"
});

async function readFile(filePath: string) {
  return fs.readFile(filePath, "utf-8");
}

const { data } = await prompt`
  Use ${readFile} to read package.json and summarize it.
`();
```

### Image Support

Pass `Buffer` or `Uint8Array` values directly in templates. They are auto-detected and sent as base64 to vision-capable models:

```typescript
import { readFileSync } from "fs";

const image = readFileSync("photo.png");

const { data } = await prompt`Describe this image: ${image}`();
```

Multiple images work too:

```typescript
const before = readFileSync("before.png");
const after = readFileSync("after.png");

const { data } = await prompt`
  Compare these two images:
  Before: ${before}
  After: ${after}
`();
```

### Multiple Tools

Embed multiple functions in a single template:

```typescript
async function readDir() {
  return fs.readdir("src", { recursive: true });
}

async function readFile(filePath: string) {
  return fs.readFile(filePath, "utf-8");
}

const { data } = await prompt`
  Use ${readDir} to list files, then use ${readFile} to read each one.
  Summarize what you find.
`();
```

### Structured Output

For LLMs that support structured output, pass a Zod schema to get typed, validated responses:

```typescript
import { z } from "zod";

const MovieSchema = z.object({
  title: z.string(),
  year: z.number(),
  rating: z.number().min(0).max(10),
});

const { data } = await prompt`
  Tell me about the movie Inception
`(MovieSchema);

// data is typed as { title: string; year: number; rating: number }
console.log(data.title, data.year);
```

Or use a `SimpleSchema` for string-only fields (no Zod required):

```typescript
const { data } = await prompt`Analyze this text: ${text}`({
  sentiment: "Overall sentiment (positive/negative/neutral)",
  confidence: "Confidence score if available",
});

// data is typed as { sentiment: string; confidence: string }
```

### Store Pattern

#### `prompt.return` — Early-Exit Structured Output

Some LLMs don't allow using both tools and structured output. When `prompt.return` appears in a template and a schema is passed, the LLM gets a special tool to store the result. The tool loop exits as soon as the value is stored:

```typescript
import { z } from "zod";

const schema = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      description: z.string(),
    }),
  ),
});

const { data } = await prompt`
  Use ${readDir} and ${readFile} to analyze the project.
  Save your analysis in ${prompt.return}.
`(schema);

console.log(data.summary);
```

#### `store()` — Explicit Store

For manual control, create a store and retrieve the value after execution:

```typescript
import { store } from "tooled-prompt";
import { z } from "zod";

const changeLog = store(
  z.object({
    summary: z.string(),
    entries: z.array(
      z.object({
        commit: z.string(),
        description: z.string(),
      }),
    ),
  }),
);

await prompt`
  Use ${gitLog} to read commits, then save a structured
  changelog in ${changeLog}.
`();

const result = changeLog.get();
```

### Adding Descriptions with `tool()`

For richer tool metadata, use `tool()` to add descriptions and explicit arg descriptors.

**Plain array descriptors:**

```typescript
import { tool } from "tooled-prompt";

function copyFile(src, dest) {
  fs.copyFileSync(src, dest);
}

tool(copyFile, {
  description: "Copy a file from source to destination",
  args: ["Source file path", "Destination file path"],
});
```

**Zod descriptors** for rich types:

```typescript
import { z } from "zod";

function createUser(name, email, age) {
  // ...
}

tool(createUser, {
  description: "Create a new user",
  args: [
    z.string().describe("User full name"),
    z.string().describe("User email address"),
    z.number().describe("User age"),
  ],
});
```

### Multiple Prompt Instances

Create isolated instances for different LLM providers or models with `createTooledPrompt`:

```typescript
import { createTooledPrompt } from "tooled-prompt";

const openai = createTooledPrompt({
  apiUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o",
});

const local = createTooledPrompt({
  apiUrl: "http://localhost:11434/v1",
  modelName: "llama3.1",
});

const { data: summary } = await openai.prompt`Summarize this document`();
const { data: translation } =
  await local.prompt`Translate to French: ${text}`();
```

Use different models for different tasks within one workflow:

```typescript
const imageLlm = createTooledPrompt({ modelName: "gemma-3-27b-it" });
const toolLlm = createTooledPrompt({ modelName: "gpt-4o" });

async function describeImage(path: string) {
  const image = readFileSync(path);
  const { data } = await imageLlm.prompt`Describe this image: ${image}`();
  return data;
}

// Tool LLM orchestrates, delegates image work to image LLM
const { data } = await toolLlm.prompt`
  Find images using ${listFiles} and describe each with ${describeImage}.
`();
```

### Providers

Built-in support for OpenAI-compatible, Anthropic, and Ollama. Set the `provider` config to switch:

```typescript
import { createTooledPrompt } from "tooled-prompt";

// OpenAI-compatible (default)
const openai = createTooledPrompt({
  provider: "openai",
  apiUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o",
});

// Anthropic
const anthropic = createTooledPrompt({
  provider: "anthropic",
  apiUrl: "https://api.anthropic.com/v1",
  apiKey: process.env.ANTHROPIC_API_KEY,
  modelName: "claude-sonnet-4-5",
  maxTokens: 8192,
});

// Ollama
const ollama = createTooledPrompt({
  provider: "ollama",
  apiUrl: "http://localhost:11434",
  modelName: "llama3.1",
});
```

You can also register custom providers:

```typescript
import { registerProvider } from "tooled-prompt";

registerProvider("my-provider", myProviderAdapter);
```

### System Prompt

Set a system prompt as a plain string or as a builder callback with tool references:

```typescript
// Plain string
const { prompt } = createTooledPrompt({
  systemPrompt: "You are a helpful assistant.",
});

// Builder callback — tools in the system prompt are available to the LLM
const { prompt } = createTooledPrompt({
  systemPrompt: (prompt) => prompt`
    You are a code assistant. Use ${searchDocs} to find relevant documentation.
  `,
});
```

## API Reference

### `prompt`

Tagged template literal for creating LLM prompts (default instance). Functions in `${}` are auto-detected as tools.

```typescript
import { prompt } from "tooled-prompt";

// Without schema — returns PromptResult<string>
const { data } = await prompt`Your prompt here`();

// With Zod schema — returns PromptResult<T>
const { data } = await prompt`Your prompt here`(zodSchema);

// With SimpleSchema — returns PromptResult<{ field: string }>
const { data } = await prompt`Your prompt here`({ field: "description" });

// Per-call config
const { data } = await prompt`Your prompt here`({ temperature: 0.9 });
```

### `setConfig`

Update configuration for the default instance.

```typescript
import { setConfig } from "tooled-prompt";

setConfig({
  apiUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
  modelName: "gpt-4o",
  temperature: 0.7,
  stream: true,
  timeout: 30000,
  silent: false,
  showThinking: false,
});
```

### `on` / `off`

Subscribe to and unsubscribe from events on the default instance.

```typescript
import { on, off } from "tooled-prompt";

const handler = (content: string) => process.stdout.write(content);
on("content", handler);
off("content", handler);
```

### `createTooledPrompt`

Create an isolated instance with its own configuration, event handlers, and tool scope.

```typescript
import { createTooledPrompt } from "tooled-prompt";

const instance = createTooledPrompt({ apiUrl: "...", apiKey: "..." });
// instance.prompt, instance.setConfig, instance.on, instance.off, instance.tool
```

### `tool`

Wrap a function with explicit metadata (description, arg descriptors).

```typescript
import { tool } from "tooled-prompt";

// Named function
tool(myFunc, { description: "...", args: ["arg1 desc", "arg2 desc"] });

// Arrow function via object syntax
tool({ myFunc }, { description: "...", args: ["arg1 desc"] });
```

### `store`

Create a typed store for capturing structured LLM output via tool calls.

```typescript
import { store } from "tooled-prompt";

const myStore = store(zodSchema);
// Use in template: ${myStore}
// Retrieve after execution: myStore.get()
```

### Event Types

```typescript
interface TooledPromptEvents {
  thinking: (content: string) => void;
  content: (content: string) => void;
  tool_call: (name: string, args: Record<string, unknown>) => void;
  tool_result: (name: string, result: string, duration: number) => void;
  tool_error: (name: string, error: string) => void;
}
```

### Configuration Options

```typescript
interface TooledPromptConfig {
  apiUrl?: string; // LLM API endpoint
  apiKey?: string; // API key
  modelName?: string; // Model name
  provider?: string; // "openai" (default) | "anthropic" | "ollama" | custom
  maxTokens?: number; // Max response tokens (required by Anthropic, defaults to 4096)
  maxIterations?: number; // Max tool loop iterations
  temperature?: number; // Generation temperature (0-2)
  stream?: boolean; // Enable streaming (default: true)
  timeout?: number; // Request timeout in ms (default: 60000)
  silent?: boolean; // Suppress console output (default: false)
  showThinking?: boolean; // Show full thinking content (default: false)
  systemPrompt?: string | SystemPromptBuilder; // System prompt (string or builder callback)
}
```

### `PromptResult<T>`

All prompt executions return a `PromptResult<T>` wrapper:

```typescript
interface PromptResult<T> {
  data: T;
}
```

## License

MIT — see [LICENSE](LICENSE) for details.
