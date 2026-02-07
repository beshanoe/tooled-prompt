# Examples

All examples require a running LLM endpoint. Copy `.env.example` to `.env` and configure your provider.

```bash
cp .env.example .env
# Edit .env with your API key and endpoint
npx tsx examples/<example>.ts
```

## Examples

| Example | Description | Features Used |
|---------|-------------|---------------|
| [weather.ts](weather.ts) | Minimal tool usage — get weather for a city | Auto-detected tool, template literal |
| [simple.ts](simple.ts) | Read and summarize project files | `tool()` with args, multiple tools |
| [structured.ts](structured.ts) | Get typed structured output with Zod | `prompt.return`, Zod schema |
| [structured-simple.ts](structured-simple.ts) | Structured output without tools | Zod schema validation |
| [describe-image.ts](describe-image.ts) | Describe an image using vision | Image support (Buffer in template) |
| [multiple-llms.ts](multiple-llms.ts) | Route tasks to different models | `createTooledPrompt()`, multi-instance |
| [git-changelog.ts](git-changelog.ts) | Generate a structured changelog from git history | `store()`, Zod schema, multiple tools |
| [github-explorer.ts](github-explorer.ts) | Analyze a GitHub user's profile and repos | Auto-detected tools, fetch-based tools |
| [npm-outdated.ts](npm-outdated.ts) | Check for outdated npm dependencies | Auto-detected tools, fetch-based tools |

## Prerequisites

| Example | Requirements |
|---------|-------------|
| Most examples | `TOOLED_PROMPT_URL`, `TOOLED_PROMPT_API_KEY` |
| describe-image.ts | Vision-capable model, `examples/image.png` |
| multiple-llms.ts | Multiple models available at the endpoint |
| git-changelog.ts | Git repository in current directory |
| github-explorer.ts | Internet access (GitHub API) |
| npm-outdated.ts | Internet access (npm registry), `package.json` in current directory |
