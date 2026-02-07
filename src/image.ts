/**
 * Internal image processing utilities
 *
 * Detects Uint8Array/Buffer values in template interpolations,
 * determines their MIME type via file-type, and converts them
 * to base64 data URLs for the OpenAI image_url content part format.
 */

import { fileTypeFromBuffer } from 'file-type';

export const IMAGE_MARKER = Symbol('image');

export type ImageMarker = { [IMAGE_MARKER]: true; url: string };

export function isImageMarker(value: unknown): value is ImageMarker {
  return typeof value === 'object' && value !== null && IMAGE_MARKER in value;
}

/**
 * Scan template values for Uint8Array instances and replace them with ImageMarkers.
 * Returns the original array unchanged if no images are found.
 */
export async function processImageValues(values: unknown[]): Promise<unknown[]> {
  // Quick scan — avoid allocation if no images
  let hasImages = false;
  for (let i = 0; i < values.length; i++) {
    if (values[i] instanceof Uint8Array) {
      hasImages = true;
      break;
    }
  }
  if (!hasImages) return values;

  const result = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value instanceof Uint8Array) {
      const ft = await fileTypeFromBuffer(value);
      const mime = ft?.mime ?? 'application/octet-stream';
      const base64 = Buffer.from(value).toString('base64');
      result[i] = { [IMAGE_MARKER]: true, url: `data:${mime};base64,${base64}` } satisfies ImageMarker;
    } else {
      result[i] = value;
    }
  }
  return result;
}
