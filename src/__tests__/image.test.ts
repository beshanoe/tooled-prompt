import { describe, it, expect } from 'vitest';
import { processImageValues, isImageMarker, IMAGE_MARKER } from '../image.js';
import { buildPromptText } from '../executor.js';
import { tool } from '../tool.js';

// Minimal valid PNG: 1x1 pixel transparent
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

// Minimal valid JPEG header
const JPEG_HEADER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00,
]);

describe('processImageValues', () => {
  it('returns same array when no Uint8Array values', async () => {
    const values = ['hello', 42, true];
    const result = await processImageValues(values);
    expect(result).toBe(values); // Same reference — no allocation
  });

  it('converts Buffer (PNG) to ImageMarker with correct mime', async () => {
    const result = await processImageValues([PNG_HEADER]);
    expect(result).toHaveLength(1);
    expect(isImageMarker(result[0])).toBe(true);
    const marker = result[0] as any;
    expect(marker.url).toMatch(/^data:image\/png;base64,/);
  });

  it('converts Buffer (JPEG) to ImageMarker with correct mime', async () => {
    const result = await processImageValues([JPEG_HEADER]);
    expect(result).toHaveLength(1);
    expect(isImageMarker(result[0])).toBe(true);
    const marker = result[0] as any;
    expect(marker.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('falls back to application/octet-stream for unknown bytes', async () => {
    const unknown = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const result = await processImageValues([unknown]);
    expect(isImageMarker(result[0])).toBe(true);
    const marker = result[0] as any;
    expect(marker.url).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('preserves non-image values alongside images', async () => {
    const values = ['text', PNG_HEADER, 42];
    const result = await processImageValues(values);
    expect(result[0]).toBe('text');
    expect(isImageMarker(result[1])).toBe(true);
    expect(result[2]).toBe(42);
  });

  it('handles plain Uint8Array (not Buffer)', async () => {
    // Copy PNG bytes into a plain Uint8Array
    const plainArray = new Uint8Array(PNG_HEADER);
    const result = await processImageValues([plainArray]);
    expect(isImageMarker(result[0])).toBe(true);
    const marker = result[0] as any;
    expect(marker.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('isImageMarker', () => {
  it('returns true for valid image marker', () => {
    const marker = { [IMAGE_MARKER]: true, url: 'data:image/png;base64,abc' };
    expect(isImageMarker(marker)).toBe(true);
  });

  it('returns false for non-marker objects', () => {
    expect(isImageMarker({})).toBe(false);
    expect(isImageMarker(null)).toBe(false);
    expect(isImageMarker('string')).toBe(false);
    expect(isImageMarker(42)).toBe(false);
    expect(isImageMarker(undefined)).toBe(false);
  });
});

describe('buildPromptText with images', () => {
  function makeStrings(...parts: string[]): TemplateStringsArray {
    return Object.assign(parts, { raw: parts }) as TemplateStringsArray;
  }

  const marker = { [IMAGE_MARKER]: true, url: 'data:image/png;base64,abc123' };

  it('returns ContentPart[] when images are present', () => {
    const strings = makeStrings('Describe this image: ', '');
    const result = buildPromptText(strings, [marker]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe this image:' });
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc123' },
    });
  });

  it('returns plain string when no images', () => {
    const strings = makeStrings('Hello ', '!');
    const result = buildPromptText(strings, ['world']);
    expect(typeof result).toBe('string');
    expect(result).toBe('Hello world!');
  });

  it('handles multiple images mixed with text', () => {
    const marker2 = { [IMAGE_MARKER]: true, url: 'data:image/jpeg;base64,xyz789' };
    const strings = makeStrings('Compare ', ' and ', ' please');
    const result = buildPromptText(strings, [marker, marker2]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts).toHaveLength(5);
    expect(parts[0]).toEqual({ type: 'text', text: 'Compare' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: marker.url } });
    expect(parts[2]).toEqual({ type: 'text', text: ' and' });
    expect(parts[3]).toEqual({ type: 'image_url', image_url: { url: marker2.url } });
    expect(parts[4]).toEqual({ type: 'text', text: ' please' });
  });

  it('handles images mixed with tools', () => {
    const myTool = tool(function analyze(x: string) { return x; });
    const strings = makeStrings('Look at ', ', use ', ' to analyze');
    const result = buildPromptText(strings, [marker, myTool]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: 'text', text: 'Look at' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: marker.url } });
    expect(parts[2]).toEqual({ type: 'text', text: ', use the "analyze" tool to analyze' });
  });

  it('trims leading whitespace on first text part and trailing on last', () => {
    const strings = makeStrings('\n  Image: ', '\n  ');
    const result = buildPromptText(strings, [marker]);

    expect(Array.isArray(result)).toBe(true);
    const parts = result as any[];
    // First text part should have leading whitespace trimmed
    expect(parts[0].text).toBe('Image:');
    // No trailing text part since it would be empty after trim
  });
});
