/**
 * Factory for creating tooled-prompt instances
 *
 * Supports configuration priority (highest to lowest):
 * 1. Per-call config (passed to executor)
 * 2. Instance config (factory initial, mutated by setConfig)
 * 3. Hardcoded defaults
 */

import type { ZodType } from 'zod';
import {
  TOOL_SYMBOL,
  type ToolFunction,
  type TooledPromptConfig,
  type ResolvedTooledPromptConfig,
  type TooledPromptInstance,
  type PromptExecutor,
  type PromptResult,
  type PromptTaggedTemplate,
  type SimpleSchema,
  type ResolvedSchema,
  type ContentPart,
  type PromptContent,
  type ProcessedSystemPrompt,
  isZodSchema,
  isSimpleSchema,
  resolveSchema,
} from './types.js';
import { tool } from './tool.js';
import { buildPromptText, runToolLoop } from './executor.js';
import { processImageValues } from './image.js';
import { TooledPromptEmitter, installDefaultHandlers, type TooledPromptEvents } from './events.js';
import { RETURN_SYMBOL, RETURN_SENTINEL, createStore } from './store.js';

/**
 * Default configuration values
 */
const DEFAULTS: ResolvedTooledPromptConfig = {
  apiUrl: '',
  modelName: '',
  apiKey: undefined,
  maxIterations: undefined,
  temperature: undefined,
  stream: true,
  timeout: 60000,
  silent: false,
  showThinking: false,
  provider: 'openai',
  maxTokens: undefined,
  systemPrompt: undefined,
  maxToolResultLength: undefined,
};

/**
 * Validate configuration values
 * @throws Error if config values are invalid
 */
function validateConfig(config: TooledPromptConfig): void {
  if (config.temperature !== undefined && (config.temperature < 0 || config.temperature > 2)) {
    throw new Error('temperature must be between 0 and 2');
  }
  if (config.maxIterations !== undefined && (config.maxIterations < 1 || !Number.isInteger(config.maxIterations))) {
    throw new Error('maxIterations must be a positive integer');
  }
  if (config.timeout !== undefined && (config.timeout < 0 || !Number.isFinite(config.timeout))) {
    throw new Error('timeout must be a positive number');
  }
  if (config.maxTokens !== undefined && (config.maxTokens < 1 || !Number.isInteger(config.maxTokens))) {
    throw new Error('maxTokens must be a positive integer');
  }
}

/**
 * Merge multiple configs, with earlier configs taking priority
 * undefined values are skipped, allowing lower-priority configs to provide defaults
 */
function mergeConfigs(...configs: TooledPromptConfig[]): ResolvedTooledPromptConfig {
  const result: Record<string, unknown> = {};

  // Process configs in order (first has highest priority)
  for (const config of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && result[key] === undefined) {
        result[key] = value;
      }
    }
  }

  // Apply defaults for any remaining undefined values
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (result[key] === undefined) {
      result[key] = value;
    }
  }

  return result as unknown as ResolvedTooledPromptConfig;
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
export function createTooledPrompt(initialConfig: TooledPromptConfig = {}): TooledPromptInstance {
  // Validate initial config
  validateConfig(initialConfig);

  // Single mutable config (copy so we don't mutate the caller's object)
  let config: TooledPromptConfig = { ...initialConfig };

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
  function resolveConfig(perCallConfig: TooledPromptConfig = {}): ResolvedTooledPromptConfig {
    return mergeConfigs(
      perCallConfig, // 1. Per-call (highest priority)
      config, // 2. Instance config (factory initial, mutated by setConfig)
      DEFAULTS, // 3. Hardcoded defaults (applied in mergeConfigs)
    );
  }

  /**
   * Update the instance configuration
   */
  function setConfig(newConfig: TooledPromptConfig): void {
    validateConfig(newConfig);
    config = { ...config, ...newConfig };
  }

  /**
   * Tagged template for system prompts — extracts tools, images, and text
   */
  function systemPromptTag(strings: TemplateStringsArray, ...values: unknown[]): ProcessedSystemPrompt {
    const spTools: ToolFunction[] = [];
    const spImages: ContentPart[] = [];

    // Extract tools and auto-wrap functions (same logic as prompt())
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (typeof value === 'function') {
        if (TOOL_SYMBOL in value) {
          spTools.push(value as ToolFunction);
        } else {
          const wrapped = tool(value as (...args: any[]) => any);
          spTools.push(wrapped as ToolFunction);
          values[i] = wrapped;
        }
      }
    }

    // Build prompt text (handles tool refs → "the X tool" and images)
    const content = buildPromptText(strings, values);

    // Separate images from content
    if (Array.isArray(content)) {
      const textParts: ContentPart[] = [];
      for (const part of content) {
        if (part.type === 'image_url') {
          spImages.push(part);
        } else {
          textParts.push(part);
        }
      }
      // Return text-only content (images go separately)
      const textContent = textParts.length === 1 && textParts[0].type === 'text' ? textParts[0].text : textParts;
      return { content: textContent as PromptContent, tools: spTools, images: spImages };
    }

    return { content, tools: spTools, images: spImages };
  }

  /**
   * Resolve system prompt config into components
   */
  function resolveSystemPrompt(config: ResolvedTooledPromptConfig): {
    systemContent?: PromptContent;
    systemTools: ToolFunction[];
    systemImages: ContentPart[];
  } {
    const sp = config.systemPrompt;
    if (sp === undefined) {
      return { systemTools: [], systemImages: [] };
    }
    if (typeof sp === 'string') {
      return { systemContent: sp, systemTools: [], systemImages: [] };
    }
    // Builder callback
    const processed = sp(systemPromptTag);
    return {
      systemContent: processed.content,
      systemTools: processed.tools,
      systemImages: processed.images,
    };
  }

  /**
   * Collect config-level tools (per-call + instance concatenated)
   */
  function collectConfigTools(perCallConfig: TooledPromptConfig = {}): ToolFunction[] {
    return [...(perCallConfig.tools || []), ...(config.tools || [])];
  }

  /**
   * Extract tools and return sentinel indices from template values.
   * Auto-wraps plain functions as tools.
   */
  function extractTemplateTools(
    strings: TemplateStringsArray,
    values: unknown[],
  ): { tools: ToolFunction[]; returnIndices: number[] } {
    const tools: ToolFunction[] = [];
    const returnIndices: number[] = [];

    for (let i = 0; i < values.length; i++) {
      const value = values[i];

      // Detect return sentinel
      if (typeof value === 'object' && value !== null && RETURN_SYMBOL in value) {
        returnIndices.push(i);
        continue;
      }

      if (typeof value === 'function') {
        // If already a tool, use as-is; otherwise auto-wrap
        if (TOOL_SYMBOL in value) {
          tools.push(value as ToolFunction);
        } else {
          const fn = value as (...args: any[]) => any;
          // Check if anonymous (no name)
          if (!fn.name) {
            // Build context from template strings
            const before = strings[i].slice(-20).trim();
            const after = strings[i + 1]?.slice(0, 20).trim() || '';
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

    return { tools, returnIndices };
  }

  /**
   * Deduplicate tools by name — later tools override earlier ones.
   */
  function deduplicateTools(previous: ToolFunction[], incoming: ToolFunction[]): ToolFunction[] {
    const byName = new Map<string, ToolFunction>();
    for (const t of previous) byName.set(t[TOOL_SYMBOL].name, t);
    for (const t of incoming) byName.set(t[TOOL_SYMBOL].name, t);
    return Array.from(byName.values());
  }

  /**
   * Shared executor logic used by both `prompt()` and `buildNext()`.
   *
   * The caller supplies the differing parts:
   * - `tools`: pre-assembled tool list (before config tools are added)
   * - `includeSystemPrompt`: whether to resolve + send the system prompt (first call only)
   * - `history`: previous messages for continuations, undefined for first call
   */
  interface ExecuteParams {
    strings: TemplateStringsArray;
    values: unknown[];
    tools: ToolFunction[];
    returnIndices: number[];
    includeSystemPrompt?: boolean;
    history?: unknown[];
  }

  function makeExecutor(params: ExecuteParams): PromptExecutor {
    const execute = async <T = string>(
      schemaOrConfig?: ZodType<T> | SimpleSchema | TooledPromptConfig,
      maybeConfig?: TooledPromptConfig,
    ): Promise<PromptResult<T>> => {
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

      const resolvedConfig = resolveConfig(perCallConfig);
      const configTools = collectConfigTools(perCallConfig);

      // Resolve system prompt (only on first call, not continuations)
      let systemContent: PromptContent | undefined;
      let systemImages: ContentPart[] | undefined;
      let systemTools: ToolFunction[] = [];
      if (params.includeSystemPrompt) {
        const sp = resolveSystemPrompt(resolvedConfig);
        systemContent = sp.systemContent;
        systemImages = sp.systemImages.length > 0 ? sp.systemImages : undefined;
        systemTools = sp.systemTools;
      }

      const baseTools = [...params.tools, ...systemTools];

      // Handle return sentinels
      if (params.returnIndices.length > 0) {
        if (!resolved) {
          throw new Error('prompt.return requires a schema — pass a Zod schema or SimpleSchema to the executor');
        }

        const resolvedValues = [...params.values];
        const returnStore = createStore<T>('return_value', resolved);

        for (const i of params.returnIndices) {
          resolvedValues[i] = returnStore;
        }

        const allTools = [...baseTools, ...configTools, returnStore as unknown as ToolFunction];
        const processed = await processImageValues(resolvedValues);
        const promptText = buildPromptText(params.strings, processed);
        const { result, messages } = await runToolLoop<T>(
          promptText,
          allTools,
          resolvedConfig,
          emitter,
          undefined,
          returnStore,
          systemContent,
          systemImages,
          params.history,
        );
        return { data: result, next: buildNext(messages, allTools) };
      }

      const allTools = [...baseTools, ...configTools];
      const processedValues = await processImageValues(params.values);
      const promptText = buildPromptText(params.strings, processedValues);
      const { result, messages } = await runToolLoop(
        promptText,
        allTools,
        resolvedConfig,
        emitter,
        resolved,
        undefined,
        systemContent,
        systemImages,
        params.history,
      );
      return { data: result, next: buildNext(messages, allTools) };
    };

    return execute as PromptExecutor;
  }

  /**
   * Build a `next` tagged template from conversation history and previous tools.
   */
  function buildNext(prevMessages: unknown[], prevTools: ToolFunction[]): PromptTaggedTemplate {
    function next(strings: TemplateStringsArray, ...values: unknown[]): PromptExecutor {
      const { tools: newTools, returnIndices } = extractTemplateTools(strings, values);
      const mergedTools = deduplicateTools(prevTools, newTools);

      return makeExecutor({
        strings,
        values,
        tools: mergedTools,
        returnIndices,
        history: prevMessages,
        includeSystemPrompt: true,
      });
    }

    (next as any).return = RETURN_SENTINEL;
    return next as PromptTaggedTemplate;
  }

  /**
   * Tagged template for defining LLM prompts
   */
  function prompt(strings: TemplateStringsArray, ...values: unknown[]): PromptExecutor {
    const { tools, returnIndices } = extractTemplateTools(strings, values);

    return makeExecutor({
      strings,
      values,
      tools,
      returnIndices,
      includeSystemPrompt: true,
    });
  }

  // Attach return sentinel to prompt
  (prompt as any).return = RETURN_SENTINEL;

  /**
   * Subscribe to an event
   */
  function on<K extends keyof TooledPromptEvents>(event: K, handler: TooledPromptEvents[K]): void {
    emitter.on(event, handler);
  }

  /**
   * Unsubscribe from an event
   */
  function off<K extends keyof TooledPromptEvents>(event: K, handler: TooledPromptEvents[K]): void {
    emitter.off(event, handler);
  }

  return {
    prompt: prompt as TooledPromptInstance['prompt'],
    tool,
    setConfig,
    on,
    off,
  };
}
