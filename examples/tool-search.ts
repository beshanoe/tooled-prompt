import './env.js';
import { z } from 'zod';
import { prompt, toolSearch, TOOL_SYMBOL } from '../src/index.js';

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

// Use a cheap LLM call as the match function — understands
// "do some math" → multiply, "send a message" → sendEmail, etc.

const search = toolSearch(add, multiply, readFile, sendEmail, {
  match: async (query, tools) => {
    const catalog = tools
      .map((t) => t[TOOL_SYMBOL])
      .map((m) => `Tool name: ${m.name}, Description: ${m.description}`)
      .join('\n');

    const { data = { tools: [] } } = await prompt`
      Tools:
      ${catalog}

      Return the names only of the tools related to this query: "${query}"
    `(
      z.object({
        tools: z.array(z.string().describe('The name of a tool to use')),
      }),
      {
        silent: true,
      },
    );

    const names = new Set(data.tools);
    return tools.filter((t) => names.has(t[TOOL_SYMBOL].name));
  },
});

const { data } = await prompt`
  What is 71231434 times 97372934? Use the available tools to compute it.
  then read file example.txt and send email to user@example.com with the result.
  ${search}
`();

console.log(`\nResult: ${data}`);
