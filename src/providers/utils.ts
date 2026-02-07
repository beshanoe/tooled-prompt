/**
 * Shared provider utilities
 */

import type { ToolMetadata } from '../types.js';

/** Parse a data URL into media type and raw base64 */
export function parseDataUrl(url: string): { mediaType: string; base64: string } {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URL');
  return { mediaType: match[1], base64: match[2] };
}

/** Convert ToolMetadata[] to OpenAI function-calling format (also used by Ollama) */
export function toolsToOpenAIFormat(tools: ToolMetadata[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map((meta) => ({
    type: 'function' as const,
    function: {
      name: meta.name,
      description: meta.description,
      parameters: meta.parameters as Record<string, unknown>,
    },
  }));
}
