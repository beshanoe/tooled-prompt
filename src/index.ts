/**
 * tooled-prompt - Runtime LLM prompt library
 *
 * @example
 * ```typescript
 * import { prompt, tool, setConfig } from 'tooled-prompt';
 *
 * // Plain function - auto-detected as tool
 * async function readFile(filePath: string) {
 *   return fs.readFile(filePath, 'utf-8');
 * }
 *
 * // Or explicitly define tool metadata
 * tool(readFile, {
 *   description: 'Read a file from disk',
 *   args: { filePath: 'Path to the file' }
 * });
 *
 * // Configure the default instance
 * setConfig({ apiKey: await getSecretKey() });
 *
 * const result = await prompt`
 *   Use ${readFile} to read config.json and summarize it.
 * `();
 *
 * // Or create isolated instances (silent by default)
 * import { createTooledPrompt } from 'tooled-prompt';
 * const openai = createTooledPrompt({ apiUrl: 'https://api.openai.com/v1' });
 * ```
 *
 * @packageDocumentation
 */

// Factory for creating isolated instances
export { createTooledPrompt } from './factory.js';

// Re-export tool utilities (these are stateless, shared across instances)
export { tool, isTool, getToolMetadata, TOOL_SYMBOL } from './tool.js';

// Store pattern for capturing structured output
export { store, createStore, RETURN_SYMBOL, RETURN_SENTINEL, type Store } from './store.js';

// Types
export type {
  ToolFunction,
  ToolMetadata,
  ToolOptions,
  ArgsForFn,
  ArgDescriptor,
  TooledPromptConfig,
  ResolvedTooledPromptConfig,
  SimpleSchema,
  JsonSchema,
  ResolvedSchema,
  PromptResult,
  PromptExecutor,
  TooledPromptInstance,
  TooledPromptEvents,
  ContentPart,
  PromptContent,
  ProcessedSystemPrompt,
  SystemPromptBuilder,
  SystemPromptTag,
} from './types.js';

// Provider system
export {
  getProvider,
  registerProvider,
  OpenAIProvider,
  AnthropicProvider,
  OllamaProvider,
  parseDataUrl,
  toolsToOpenAIFormat,
  type ProviderAdapter,
  type ToolCallInfo,
  type ToolResultInfo,
  type ParsedResponse,
  type BuildRequestParams,
  type BuildRequestResult,
} from './providers/index.js';

// Event utilities
export {
  TooledPromptEmitter,
  type TooledPromptEvents as Events,
  defaultContentHandler,
  defaultThinkingHandler,
  defaultToolCallHandler,
  defaultToolResultHandler,
  defaultToolErrorHandler,
  installDefaultHandlers,
  type DefaultHandlerOptions,
} from './events.js';

// Create the default instance with factory defaults
import { createTooledPrompt } from './factory.js';

const defaultInstance = createTooledPrompt();

/**
 * Tagged template for creating LLM prompts (default instance)
 *
 * The default instance has logging enabled - it streams content to stdout
 * and logs tool calls. Use `setConfig({ silent: true })` to disable.
 *
 * @example
 * ```typescript
 * const result = await prompt`Use ${readFile} to read config.json`();
 * ```
 */
export const prompt = defaultInstance.prompt;

/**
 * Update configuration for the default instance
 *
 * @example
 * ```typescript
 * setConfig({ apiKey: await getSecretKey() });
 * setConfig({ silent: true }); // Disable logging
 * ```
 */
export const setConfig = defaultInstance.setConfig;

/**
 * Subscribe to events on the default instance
 *
 * @example
 * ```typescript
 * on('tool_call', (name, args) => {
 *   console.log(`Calling ${name} with`, args);
 * });
 * ```
 */
export const on = defaultInstance.on;

/**
 * Unsubscribe from events on the default instance
 */
export const off = defaultInstance.off;
