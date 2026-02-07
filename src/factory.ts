/**
 * Factory for creating tooled-prompt instances
 *
 * Supports configuration priority (highest to lowest):
 * 1. Per-call config (passed to executor)
 * 2. setConfig() updates
 * 3. Factory initial config
 * 4. Hardcoded defaults
 */

import type { ZodType } from "zod";
import {
  TOOL_SYMBOL,
  type ToolFunction,
  type TooledPromptConfig,
  type ResolvedTooledPromptConfig,
  type TooledPromptInstance,
  type PromptExecutor,
  type PromptResult,
  type SimpleSchema,
  type ResolvedSchema,
  isZodSchema,
  isSimpleSchema,
  resolveSchema,
} from "./types.js";
import { tool } from "./tool.js";
import { buildPromptText, runToolLoop } from "./executor.js";
import { processImageValues } from "./image.js";
import {
  TooledPromptEmitter,
  installDefaultHandlers,
  type TooledPromptEvents,
} from "./events.js";
import {
  RETURN_SYMBOL,
  RETURN_SENTINEL,
  createStore,
  type Store,
} from "./store.js";

/**
 * Default configuration values
 */
const DEFAULTS: ResolvedTooledPromptConfig = {
  apiUrl: "",
  modelName: "",
  apiKey: undefined,
  maxIterations: undefined,
  temperature: undefined,
  stream: true,
  timeout: 60000,
  silent: false,
  showThinking: false,
};

/**
 * Validate configuration values
 * @throws Error if config values are invalid
 */
function validateConfig(config: TooledPromptConfig): void {
  if (
    config.temperature !== undefined &&
    (config.temperature < 0 || config.temperature > 2)
  ) {
    throw new Error("temperature must be between 0 and 2");
  }
  if (
    config.maxIterations !== undefined &&
    (config.maxIterations < 1 || !Number.isInteger(config.maxIterations))
  ) {
    throw new Error("maxIterations must be a positive integer");
  }
  if (
    config.timeout !== undefined &&
    (config.timeout < 0 || !Number.isFinite(config.timeout))
  ) {
    throw new Error("timeout must be a positive number");
  }
}

/**
 * Merge multiple configs, with earlier configs taking priority
 * undefined values are skipped, allowing lower-priority configs to provide defaults
 */
function mergeConfigs(
  ...configs: TooledPromptConfig[]
): ResolvedTooledPromptConfig {
  const result: TooledPromptConfig = {};

  // Process configs in order (first has highest priority)
  for (const config of configs) {
    if (config.apiUrl !== undefined && result.apiUrl === undefined) {
      result.apiUrl = config.apiUrl;
    }
    if (config.modelName !== undefined && result.modelName === undefined) {
      result.modelName = config.modelName;
    }
    if (config.apiKey !== undefined && result.apiKey === undefined) {
      result.apiKey = config.apiKey;
    }
    if (
      config.maxIterations !== undefined &&
      result.maxIterations === undefined
    ) {
      result.maxIterations = config.maxIterations;
    }
    if (config.temperature !== undefined && result.temperature === undefined) {
      result.temperature = config.temperature;
    }
    if (config.stream !== undefined && result.stream === undefined) {
      result.stream = config.stream;
    }
    if (config.timeout !== undefined && result.timeout === undefined) {
      result.timeout = config.timeout;
    }
    if (config.silent !== undefined && result.silent === undefined) {
      result.silent = config.silent;
    }
    if (
      config.showThinking !== undefined &&
      result.showThinking === undefined
    ) {
      result.showThinking = config.showThinking;
    }
  }

  // Apply defaults for any remaining undefined values
  return {
    apiUrl: result.apiUrl ?? DEFAULTS.apiUrl,
    modelName: result.modelName ?? DEFAULTS.modelName,
    apiKey: result.apiKey ?? DEFAULTS.apiKey,
    maxIterations: result.maxIterations ?? DEFAULTS.maxIterations,
    temperature: result.temperature ?? DEFAULTS.temperature,
    stream: result.stream ?? DEFAULTS.stream,
    timeout: result.timeout ?? DEFAULTS.timeout,
    silent: result.silent ?? DEFAULTS.silent,
    showThinking: result.showThinking ?? DEFAULTS.showThinking,
  };
}

/**
 * Create a tooled-prompt instance with its own configuration
 *
 * @param config - Initial configuration (optional)
 * @returns A tooled-prompt instance with prompt, tool, setConfig, on, and off
 *
 * @example
 * ```typescript
 * // Create with defaults (silent)
 * const { prompt, tool, setConfig, on } = createTooledPrompt();
 *
 * // Create with custom config
 * const anthropic = createTooledPrompt({
 *   apiUrl: 'https://api.anthropic.com/v1',
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 * });
 *
 * // Multiple isolated instances
 * const openai = createTooledPrompt({ apiUrl: 'https://api.openai.com/v1' });
 * const local = createTooledPrompt({ apiUrl: 'http://localhost:8080/v1' });
 * ```
 */
export function createTooledPrompt(
  config: TooledPromptConfig = {},
): TooledPromptInstance {
  const initialConfig = config;

  // Validate initial config
  validateConfig(initialConfig);

  // Instance config (mutable via setConfig)
  let instanceConfig: TooledPromptConfig = {};

  // Event emitter for this instance
  const emitter = new TooledPromptEmitter();

  // Auto-install default logging handlers (gated by config)
  installDefaultHandlers(emitter, {
    isSilent: () => resolveConfig().silent,
    showThinking: () => resolveConfig().showThinking,
  });

  /**
   * Resolve the current config by merging all sources
   */
  function resolveConfig(
    perCallConfig: TooledPromptConfig = {},
  ): ResolvedTooledPromptConfig {
    return mergeConfigs(
      perCallConfig, // 1. Per-call (highest priority)
      instanceConfig, // 2. setConfig() updates
      initialConfig, // 3. Factory initial config
      DEFAULTS, // 4. Hardcoded defaults (applied in mergeConfigs)
    );
  }

  /**
   * Update the instance configuration
   */
  function setConfig(config: TooledPromptConfig): void {
    validateConfig(config);
    instanceConfig = { ...instanceConfig, ...config };
  }

  /**
   * Tagged template for defining LLM prompts
   */
  function prompt(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): PromptExecutor {
    // Extract and auto-wrap tools from values, track return sentinel indices
    const tools: ToolFunction[] = [];
    const returnIndices: number[] = [];

    for (let i = 0; i < values.length; i++) {
      const value = values[i];

      // Detect return sentinel
      if (
        typeof value === "object" &&
        value !== null &&
        RETURN_SYMBOL in value
      ) {
        returnIndices.push(i);
        continue;
      }

      if (typeof value === "function") {
        // If already a tool, use as-is; otherwise auto-wrap
        if (TOOL_SYMBOL in value) {
          tools.push(value as ToolFunction);
        } else {
          const fn = value as (...args: any[]) => any;
          // Check if anonymous (no name)
          if (!fn.name) {
            // Build context from template strings
            const before = strings[i].slice(-20).trim();
            const after = strings[i + 1]?.slice(0, 20).trim() || "";
            const wrapped = tool(fn);
            const assignedName = (wrapped as ToolFunction)[TOOL_SYMBOL].name;

            console.warn(
              `⚠️  Anonymous function detected (assigned name: ${assignedName})\n` +
                `    Location: ...${before} \${} ${after}...\n` +
                `    Tip: Use tool({ myFunc }) to provide a name`,
            );
            tools.push(wrapped as ToolFunction);
          } else {
            // Auto-wrap plain function as tool
            const wrapped = tool(fn);
            tools.push(wrapped as ToolFunction);
          }
        }
      }
    }

    // Return function with overloaded signature handling
    const execute = async <T = string>(
      schemaOrConfig?: ZodType<T> | SimpleSchema | TooledPromptConfig,
      maybeConfig?: TooledPromptConfig,
    ): Promise<PromptResult<T>> => {
      // Detect if first arg is a Zod schema, SimpleSchema, or config
      let resolved: ResolvedSchema<T> | undefined;
      let perCallConfig: TooledPromptConfig;

      if (isZodSchema(schemaOrConfig)) {
        resolved = resolveSchema<T>(schemaOrConfig);
        perCallConfig = maybeConfig || {};
      } else if (isSimpleSchema(schemaOrConfig)) {
        resolved = resolveSchema<T>(schemaOrConfig);
        perCallConfig = maybeConfig || {};
      } else {
        resolved = undefined;
        perCallConfig = (schemaOrConfig as TooledPromptConfig) || {};
      }

      // Resolve config using the priority chain
      const resolvedConfig = resolveConfig(perCallConfig);

      // Handle return sentinels
      if (returnIndices.length > 0) {
        if (!resolved) {
          throw new Error(
            "prompt.return requires a schema — pass a Zod schema or SimpleSchema to the executor",
          );
        }

        // Create a single return store and replace all sentinel positions with it
        const resolvedValues = [...values];
        const returnStore = createStore<T>("return_value", resolved);

        for (const i of returnIndices) {
          resolvedValues[i] = returnStore;
        }

        const allTools = [...tools, returnStore as unknown as ToolFunction];
        const processed = await processImageValues(resolvedValues);
        const promptText = buildPromptText(strings, processed);
        // No schema passed to runToolLoop — structured output comes via the store tool
        const result = await runToolLoop<T>(
          promptText,
          allTools,
          resolvedConfig,
          emitter,
          undefined,
          returnStore,
        );
        return { data: result };
      }

      const processedValues = await processImageValues(values);
      const promptText = buildPromptText(strings, processedValues);
      const result = await runToolLoop(promptText, tools, resolvedConfig, emitter, resolved);
      return { data: result };
    };

    return execute as PromptExecutor;
  }

  // Attach return sentinel to prompt
  (prompt as any).return = RETURN_SENTINEL;

  /**
   * Subscribe to an event
   */
  function on<K extends keyof TooledPromptEvents>(
    event: K,
    handler: TooledPromptEvents[K],
  ): void {
    emitter.on(event, handler);
  }

  /**
   * Unsubscribe from an event
   */
  function off<K extends keyof TooledPromptEvents>(
    event: K,
    handler: TooledPromptEvents[K],
  ): void {
    emitter.off(event, handler);
  }

  return {
    prompt: prompt as TooledPromptInstance["prompt"],
    tool,
    setConfig,
    on,
    off,
  };
}
