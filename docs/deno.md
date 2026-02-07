# Even Quicker Start: Deno

Deno supports npm packages natively. No install step needed.

```typescript
import { prompt, setConfig } from "npm:tooled-prompt";

setConfig({
  llmUrl: "https://api.openai.com/v1",
  apiKey: Deno.env.get("OPENAI_API_KEY"),
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

Run with:

```bash
deno run --allow-net --allow-env weather.ts
```

- `--allow-net` — required for LLM API calls
- `--allow-env` — required if reading API keys from environment variables

Add other permissions as needed by your tool functions (e.g. `--allow-read` for file access).
