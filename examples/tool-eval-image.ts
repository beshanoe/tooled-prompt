import './env.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prompt, toolEval } from '../src/index.js';

// A tool that returns an image buffer
function loadImage(name: string) {
  return readFileSync(resolve(import.meta.dirname, `./${name}`));
}

// toolEval wraps the tool — the LLM writes JS code that calls it.
// When the code returns a Uint8Array, it's sent back as an image.
const exec = toolEval(loadImage);

await prompt`
  Load the file "image.png" and describe what you see.
  ${exec}
`();
