import "dotenv/config";
import { setConfig } from "../src/index.js";

setConfig({
  llmUrl: process.env.TOOLED_PROMPT_URL || process.env.TOOLED_PROMPT_LLM_URL,
  llmModel: process.env.TOOLED_PROMPT_MODEL || process.env.TOOLED_PROMPT_LLM_MODEL,
  apiKey: process.env.TOOLED_PROMPT_API_KEY,
  temperature: process.env.TOOLED_PROMPT_TEMPERATURE ? parseFloat(process.env.TOOLED_PROMPT_TEMPERATURE) : undefined,
  maxIterations: process.env.TOOLED_PROMPT_MAX_ITERATIONS ? parseInt(process.env.TOOLED_PROMPT_MAX_ITERATIONS, 10) : undefined,
  stream: process.env.TOOLED_PROMPT_STREAM !== undefined ? process.env.TOOLED_PROMPT_STREAM === "true" : undefined,
  timeout: process.env.TOOLED_PROMPT_TIMEOUT ? parseInt(process.env.TOOLED_PROMPT_TIMEOUT, 10) : undefined,
  silent: process.env.TOOLED_PROMPT_SILENT !== undefined ? process.env.TOOLED_PROMPT_SILENT === "true" : undefined,
  showThinking: process.env.TOOLED_PROMPT_SHOW_THINKING !== undefined ? process.env.TOOLED_PROMPT_SHOW_THINKING === "true" : undefined,
});
