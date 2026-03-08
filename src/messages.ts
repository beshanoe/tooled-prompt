/**
 * Messages sentinel for injecting conversation history into prompts
 */

export const MESSAGES_SYMBOL = Symbol.for('tooled-prompt.messages');

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface MessagesSentinel {
  readonly [MESSAGES_SYMBOL]: true;
  readonly messages: HistoryMessage[];
}

export function createMessagesSentinel(messages: HistoryMessage[]): MessagesSentinel {
  return { [MESSAGES_SYMBOL]: true, messages };
}
