import './env.js';
import { prompt, toolEval } from '../src/index.js';

// Define several tools — no special descriptions needed
function add(a: string, b: string): string {
  return String(Number(a) + Number(b));
}

function multiply(a: string, b: string): string {
  return String(Number(a) * Number(b));
}

function readFile(path: string): string {
  return `[mock] Contents of ${path}`;
}

function sendEmail(to: string, body: string): string {
  return `[mock] Email sent to ${to}: ${body}`;
}

// toolEval lets the LLM write a JS function body that orchestrates
// multiple tools in a single turn — no round-trip overhead per tool call.

const exec = toolEval(add, multiply, readFile, sendEmail);

const { data } = await prompt`
  What is 71231434 times 97372934? Use the available tools to compute it.
  then read file example.txt and send email to user@example.com with the result.
  ${exec}
`();

console.log(`\nResult: ${data}`);
