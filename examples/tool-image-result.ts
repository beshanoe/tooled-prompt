import './env.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prompt, tool } from '../src/index.js';

// A tool that returns an image buffer — the LLM will see the image
function loadImage() {
  return readFileSync(resolve(import.meta.dirname, './image.png'));
}
tool(loadImage, { description: 'Load a test image from disk and return it' });

await prompt`Use ${loadImage} to load the image, then describe what you see in detail.`();
