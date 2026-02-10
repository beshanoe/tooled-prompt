/**
 * Event system for tooled-prompt
 *
 * Provides a simple event emitter for streaming LLM events
 */

function wrap(style: string, text: string): string {
  if (typeof process !== 'undefined' && process.env && 'NO_COLOR' in process.env) {
    return text;
  }
  return `\x1b[${style}m${text}\x1b[0m`;
}

function writeStdout(text: string): void {
  if (typeof process !== 'undefined' && process.stdout) {
    process.stdout.write(text);
  }
}

function formatLabel(text: string, kind: 'thinking' | 'response'): string {
  if (kind === 'thinking') return wrap('33', text);
  return wrap('1', text);
}

/**
 * Event types emitted during prompt execution
 */
export interface TooledPromptEvents {
  /** Emitted at the start of each prompt execution */
  start: () => void;
  /** Thinking/reasoning content from the LLM */
  thinking: (content: string) => void;
  /** Response content from the LLM */
  content: (content: string) => void;
  /** Tool call started */
  tool_call: (name: string, args: Record<string, unknown>) => void;
  /** Tool call completed successfully */
  tool_result: (name: string, result: string, duration: number) => void;
  /** Tool call failed */
  tool_error: (name: string, error: string) => void;
}

/**
 * Event handler function type
 */
type EventHandler<K extends keyof TooledPromptEvents> = TooledPromptEvents[K];

/**
 * Simple typed event emitter for tooled-prompt events
 */
export class TooledPromptEmitter {
  private handlers = new Map<keyof TooledPromptEvents, Set<(...args: any[]) => void>>();

  /**
   * Subscribe to an event
   */
  on<K extends keyof TooledPromptEvents>(event: K, handler: EventHandler<K>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as (...args: any[]) => void);
  }

  /**
   * Unsubscribe from an event
   */
  off<K extends keyof TooledPromptEvents>(event: K, handler: EventHandler<K>): void {
    this.handlers.get(event)?.delete(handler as (...args: any[]) => void);
  }

  /**
   * Emit an event to all subscribers
   */
  emit<K extends keyof TooledPromptEvents>(event: K, ...args: Parameters<TooledPromptEvents[K]>): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        handler(...args);
      }
    }
  }

  /**
   * Check if there are any handlers for an event
   */
  hasHandlers<K extends keyof TooledPromptEvents>(event: K): boolean {
    const handlers = this.handlers.get(event);
    return handlers !== undefined && handlers.size > 0;
  }

  /**
   * Remove all handlers for all events
   */
  clear(): void {
    this.handlers.clear();
  }
}

/**
 * Default content handler - writes to stdout
 */
export function defaultContentHandler(content: string): void {
  writeStdout(content);
}

/**
 * Default thinking handler - writes to stdout with formatting
 */
export function defaultThinkingHandler(content: string): void {
  writeStdout(wrap('2;3', content));
}

/**
 * Default tool_call handler - logs tool invocation
 */
export function defaultToolCallHandler(name: string, args: Record<string, unknown>): void {
  const argParts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value.length > 100) {
      argParts.push(`  ${key}: "${value.slice(0, 100)}..." (${value.length} chars)`);
    } else if (typeof value === 'string') {
      argParts.push(`  ${key}: "${value}"`);
    } else {
      argParts.push(`  ${key}: ${JSON.stringify(value)}`);
    }
  }
  console.log(wrap('36', `\n[Tool] ${name}(${argParts.length > 0 ? '\n' + argParts.join('\n') + '\n)' : ')'}`));
}

/**
 * Default tool_result handler - logs result
 */
export function defaultToolResultHandler(_name: string, result: string, _duration: number): void {
  const display = result.length > 200 ? result.slice(0, 200) + `... (${result.length} total chars)` : result;
  console.log(wrap('32', '[Result]:'), display);
}

/**
 * Default tool_error handler - logs error
 */
export function defaultToolErrorHandler(name: string, error: string): void {
  console.error(wrap('31', `[Error] ${name}:`), error);
}

/**
 * Options for installDefaultHandlers
 */
export interface DefaultHandlerOptions {
  /** When returns true, suppresses all console output */
  isSilent?: () => boolean;
  /** When returns true, streams full thinking content instead of just showing a label */
  showThinking?: () => boolean;
}

/**
 * Install default logging handlers on an emitter
 *
 * @param target - Object with an `on` method for subscribing to events
 * @param options - Optional getters for silent and showThinking behavior
 */
export function installDefaultHandlers(
  target: { on: TooledPromptEmitter['on'] },
  options?: DefaultHandlerOptions,
): void {
  const silent = options?.isSilent ?? (() => false);
  const showThinking = options?.showThinking ?? (() => false);
  let inThinking = false;
  let hasContent = false;

  target.on('start', () => {
    inThinking = false;
    hasContent = false;
  });

  target.on('thinking', (content) => {
    if (!inThinking) {
      inThinking = true;
      if (!silent()) {
        writeStdout('\n' + formatLabel('[Thinking]', 'thinking') + ' ');
        if (!showThinking()) writeStdout('...');
      }
    }
    if (!silent() && showThinking()) writeStdout(wrap('2;3', content));
  });

  target.on('content', (content) => {
    if (!hasContent) {
      hasContent = true;
      if (!silent()) {
        const prefix = inThinking ? '\n\n' : '\n';
        writeStdout(prefix + formatLabel('[Response]', 'response') + ' ');
      }
      inThinking = false;
    }
    if (!silent()) writeStdout(content);
  });

  target.on('tool_call', (name, args) => {
    inThinking = false;
    hasContent = false;
    if (!silent()) defaultToolCallHandler(name, args);
  });

  target.on('tool_result', (...args) => {
    if (!silent()) defaultToolResultHandler(...args);
  });
  target.on('tool_error', (...args) => {
    if (!silent()) defaultToolErrorHandler(...args);
  });
}
