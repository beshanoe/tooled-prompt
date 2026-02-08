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

/** Recursively add `additionalProperties: false` to all object types in a JSON schema */
export function enforceAdditionalProperties(node: Record<string, unknown>): Record<string, unknown> {
  const result = { ...node };
  if (result.type === 'object') {
    result.additionalProperties = false;
  }
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'object' && item !== null
          ? enforceAdditionalProperties(item as Record<string, unknown>)
          : item
      );
    } else if (typeof value === 'object' && value !== null) {
      result[key] = enforceAdditionalProperties(value as Record<string, unknown>);
    }
  }
  return result;
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
      parameters: meta.parameters,
    },
  }));
}
