import './env.js';
import { prompt, setConfig } from '../src/index.js';

function getTime(): string {
  return new Date().toLocaleTimeString();
}

setConfig({
  systemPrompt: (p) => p`You are a helpful assistant. Use ${getTime} when asked about the current time.`,
});

const { data } = await prompt`What time is it right now?`();

console.log(`\nResult: ${data}`);
