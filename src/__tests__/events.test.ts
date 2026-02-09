import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TooledPromptEmitter,
  defaultContentHandler,
  defaultThinkingHandler,
  defaultToolCallHandler,
  defaultToolResultHandler,
  defaultToolErrorHandler,
  installDefaultHandlers,
} from '../events.js';

describe('TooledPromptEmitter', () => {
  let emitter: TooledPromptEmitter;

  beforeEach(() => {
    emitter = new TooledPromptEmitter();
  });

  describe('on/emit', () => {
    it('calls handler when event is emitted', () => {
      const handler = vi.fn();
      emitter.on('content', handler);
      emitter.emit('content', 'hello');
      expect(handler).toHaveBeenCalledWith('hello');
    });

    it('calls multiple handlers for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('content', handler1);
      emitter.on('content', handler2);
      emitter.emit('content', 'test');
      expect(handler1).toHaveBeenCalledWith('test');
      expect(handler2).toHaveBeenCalledWith('test');
    });

    it('passes all arguments to handler', () => {
      const handler = vi.fn();
      emitter.on('tool_result', handler);
      emitter.emit('tool_result', 'myTool', 'result data', 123);
      expect(handler).toHaveBeenCalledWith('myTool', 'result data', 123);
    });

    it('does not throw when emitting without handlers', () => {
      expect(() => emitter.emit('content', 'test')).not.toThrow();
    });
  });

  describe('off', () => {
    it('removes handler so it is not called', () => {
      const handler = vi.fn();
      emitter.on('content', handler);
      emitter.off('content', handler);
      emitter.emit('content', 'test');
      expect(handler).not.toHaveBeenCalled();
    });

    it('only removes specific handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      emitter.on('content', handler1);
      emitter.on('content', handler2);
      emitter.off('content', handler1);
      emitter.emit('content', 'test');
      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('test');
    });

    it('does not throw when removing non-existent handler', () => {
      const handler = vi.fn();
      expect(() => emitter.off('content', handler)).not.toThrow();
    });
  });

  describe('hasHandlers', () => {
    it('returns false when no handlers registered', () => {
      expect(emitter.hasHandlers('content')).toBe(false);
    });

    it('returns true when handlers are registered', () => {
      emitter.on('content', vi.fn());
      expect(emitter.hasHandlers('content')).toBe(true);
    });

    it('returns false after all handlers removed', () => {
      const handler = vi.fn();
      emitter.on('content', handler);
      emitter.off('content', handler);
      expect(emitter.hasHandlers('content')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all handlers', () => {
      const contentHandler = vi.fn();
      const thinkingHandler = vi.fn();
      emitter.on('content', contentHandler);
      emitter.on('thinking', thinkingHandler);
      emitter.clear();
      emitter.emit('content', 'test');
      emitter.emit('thinking', 'test');
      expect(contentHandler).not.toHaveBeenCalled();
      expect(thinkingHandler).not.toHaveBeenCalled();
    });
  });

  describe('event types', () => {
    it('handles thinking event', () => {
      const handler = vi.fn();
      emitter.on('thinking', handler);
      emitter.emit('thinking', 'pondering...');
      expect(handler).toHaveBeenCalledWith('pondering...');
    });

    it('handles tool_call event', () => {
      const handler = vi.fn();
      emitter.on('tool_call', handler);
      emitter.emit('tool_call', 'readFile', { path: '/tmp/test.txt' });
      expect(handler).toHaveBeenCalledWith('readFile', { path: '/tmp/test.txt' });
    });

    it('handles tool_result event', () => {
      const handler = vi.fn();
      emitter.on('tool_result', handler);
      emitter.emit('tool_result', 'readFile', 'file contents', 50);
      expect(handler).toHaveBeenCalledWith('readFile', 'file contents', 50);
    });

    it('handles tool_error event', () => {
      const handler = vi.fn();
      emitter.on('tool_error', handler);
      emitter.emit('tool_error', 'readFile', 'File not found');
      expect(handler).toHaveBeenCalledWith('readFile', 'File not found');
    });
  });
});

describe('default handlers', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutWriteSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleLogSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    stdoutWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('defaultContentHandler writes to stdout', () => {
    defaultContentHandler('hello world');
    expect(stdoutWriteSpy).toHaveBeenCalledWith('hello world');
  });

  it('defaultThinkingHandler writes to stdout', () => {
    defaultThinkingHandler('thinking...');
    expect(stdoutWriteSpy).toHaveBeenCalledWith('thinking...');
  });

  it('defaultToolCallHandler logs tool invocation', () => {
    defaultToolCallHandler('myTool', { arg1: 'value1' });
    expect(consoleLogSpy).toHaveBeenCalled();
    const logCall = consoleLogSpy.mock.calls[0][0] as string;
    expect(logCall).toContain('[Tool]');
    expect(logCall).toContain('myTool');
  });

  it('defaultToolResultHandler logs result', () => {
    defaultToolResultHandler('myTool', 'result data', 100);
    expect(consoleLogSpy).toHaveBeenCalledWith('[Result]:', 'result data');
  });

  it('defaultToolResultHandler truncates long results with char count', () => {
    const longResult = 'x'.repeat(300);
    defaultToolResultHandler('myTool', longResult, 100);
    expect(consoleLogSpy).toHaveBeenCalled();
    const logCall = consoleLogSpy.mock.calls[0][1] as string;
    expect(logCall.length).toBeLessThan(longResult.length);
    expect(logCall).toContain('...');
    expect(logCall).toContain('(300 total chars)');
  });

  it('defaultToolErrorHandler logs error', () => {
    defaultToolErrorHandler('myTool', 'Something went wrong');
    expect(consoleErrorSpy).toHaveBeenCalledWith('[Error] myTool:', 'Something went wrong');
  });
});

describe('default handlers output verification', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
  });

  it('defaultContentHandler writes exact content without modification', () => {
    const output: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(chunk as string);
      return true;
    });

    defaultContentHandler('Hello, World!');
    defaultContentHandler('\n');
    defaultContentHandler('Line 2');

    expect(output).toEqual(['Hello, World!', '\n', 'Line 2']);

    stdoutSpy.mockRestore();
  });

  it('defaultThinkingHandler writes thinking content without modification', () => {
    const output: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(chunk as string);
      return true;
    });

    defaultThinkingHandler('Processing...');
    defaultThinkingHandler(' still thinking');

    expect(output).toEqual(['Processing...', ' still thinking']);

    stdoutSpy.mockRestore();
  });

  it('defaultToolCallHandler formats tool name and arguments correctly', () => {
    const output: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push(args.join(' '));
    });

    defaultToolCallHandler('readFile', { path: '/tmp/test.txt', encoding: 'utf8' });

    expect(output.length).toBe(1);
    expect(output[0]).toContain('[Tool]');
    expect(output[0]).toContain('readFile');
    expect(output[0]).toContain('/tmp/test.txt');

    logSpy.mockRestore();
  });

  it('defaultToolResultHandler formats result with correct prefix', () => {
    const output: Array<{ args: unknown[] }> = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push({ args });
    });

    defaultToolResultHandler('myTool', 'success result', 150);

    expect(output.length).toBe(1);
    expect(output[0].args[0]).toBe('[Result]:');
    expect(output[0].args[1]).toBe('success result');

    logSpy.mockRestore();
  });

  it('defaultToolResultHandler truncation preserves start of result', () => {
    const output: Array<{ args: unknown[] }> = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      output.push({ args });
    });

    const longResult = 'START_' + 'x'.repeat(300) + '_END';
    defaultToolResultHandler('myTool', longResult, 100);

    const truncatedResult = output[0].args[1] as string;
    expect(truncatedResult).toContain('START_');
    expect(truncatedResult).not.toContain('_END');
    expect(truncatedResult).toContain('...');
    expect(truncatedResult).toContain('total chars)');

    logSpy.mockRestore();
  });

  it('defaultToolErrorHandler formats error with tool name', () => {
    const output: Array<{ args: unknown[] }> = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      output.push({ args });
    });

    defaultToolErrorHandler('failingTool', 'Connection refused');

    expect(output.length).toBe(1);
    expect(output[0].args[0]).toBe('[Error] failingTool:');
    expect(output[0].args[1]).toBe('Connection refused');

    errorSpy.mockRestore();
  });
});

describe('installDefaultHandlers', () => {
  let stdoutWriteSpy: any;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.NO_COLOR = '1';
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.NO_COLOR;
    stdoutWriteSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('installs all default handlers', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter);

    expect(emitter.hasHandlers('content')).toBe(true);
    expect(emitter.hasHandlers('thinking')).toBe(true);
    expect(emitter.hasHandlers('tool_call')).toBe(true);
    expect(emitter.hasHandlers('tool_result')).toBe(true);
    expect(emitter.hasHandlers('tool_error')).toBe(true);
  });

  it('emits [Thinking] then [Response] labels for thinking → content transition (showThinking)', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter, { showThinking: () => true });

    const output: string[] = [];
    stdoutWriteSpy.mockImplementation((chunk: any) => {
      output.push(chunk);
      return true;
    });

    emitter.emit('thinking', 'hmm');
    emitter.emit('thinking', ' interesting');
    emitter.emit('content', 'Hello');
    emitter.emit('content', ' World');

    expect(output[0]).toBe('\n[Thinking] ');
    expect(output[1]).toBe('hmm');
    expect(output[2]).toBe(' interesting');
    expect(output[3]).toBe('\n\n[Response] ');
    expect(output[4]).toBe('Hello');
    expect(output[5]).toBe(' World');
  });

  it('shows [Thinking] ... label when showThinking is false (default)', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter);

    const output: string[] = [];
    stdoutWriteSpy.mockImplementation((chunk: any) => {
      output.push(chunk);
      return true;
    });

    emitter.emit('thinking', 'hmm');
    emitter.emit('thinking', ' interesting');
    emitter.emit('content', 'Hello');

    expect(output[0]).toBe('\n[Thinking] ');
    expect(output[1]).toBe('...');
    // No thinking content streamed
    expect(output[2]).toBe('\n\n[Response] ');
    expect(output[3]).toBe('Hello');
  });

  it('emits [Response] label for content-only (no thinking)', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter);

    const output: string[] = [];
    stdoutWriteSpy.mockImplementation((chunk: any) => {
      output.push(chunk);
      return true;
    });

    emitter.emit('content', 'Hello');
    emitter.emit('content', ' World');

    expect(output[0]).toBe('\n[Response] ');
    expect(output[1]).toBe('Hello');
    expect(output[2]).toBe(' World');
  });

  it('suppresses stdout when isSilent returns true', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter, { isSilent: () => true });

    emitter.emit('thinking', 'hmm');
    emitter.emit('content', 'Hello');
    emitter.emit('tool_call', 'myTool', { arg: 'val' });
    emitter.emit('tool_result', 'myTool', 'result', 50);
    emitter.emit('tool_error', 'myTool', 'err');

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('tracks state correctly when silent, so labels work when toggled off', () => {
    const emitter = new TooledPromptEmitter();
    let silent = true;
    installDefaultHandlers(emitter, { isSilent: () => silent });

    const output: string[] = [];
    stdoutWriteSpy.mockImplementation((chunk: any) => {
      output.push(chunk);
      return true;
    });

    // Emit while silent — no output but state tracks
    emitter.emit('thinking', 'hmm');
    emitter.emit('content', 'Hello');
    expect(output).toHaveLength(0);

    // Tool call resets state
    emitter.emit('tool_call', 'myTool', { arg: 'val' });

    // Toggle off silent
    silent = false;

    // Now content should get a fresh [Response] label
    emitter.emit('content', 'World');
    expect(output[0]).toBe('\n[Response] ');
    expect(output[1]).toBe('World');
  });

  it('resets label state on tool_call', () => {
    const emitter = new TooledPromptEmitter();
    installDefaultHandlers(emitter);

    const output: string[] = [];
    stdoutWriteSpy.mockImplementation((chunk: any) => {
      output.push(chunk);
      return true;
    });

    // First turn: content
    emitter.emit('content', 'First');
    // Tool call resets state
    emitter.emit('tool_call', 'myTool', { arg: 'val' });
    // Second turn: content should get fresh [Response] label
    emitter.emit('content', 'Second');

    expect(output[0]).toBe('\n[Response] ');
    expect(output[1]).toBe('First');
    // After tool_call, next content should get a new label
    expect(output[2]).toBe('\n[Response] ');
    expect(output[3]).toBe('Second');
  });
});
