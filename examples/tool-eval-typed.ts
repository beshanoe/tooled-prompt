import './env.js';
import { prompt, tool, toolEval } from '../src/index.js';
import { z } from 'zod';

// Tools with return types help the LLM chain calls correctly.
// The return type becomes a @returns annotation in the JSDoc the LLM sees.

function add(a: string, b: string): string {
  return String(Number(a) + Number(b));
}
tool(add, { returns: 'The numeric sum as a string' });

function multiply(a: string, b: string): string {
  return String(Number(a) * Number(b));
}
tool(multiply, { returns: 'The numeric product as a string' });

// Zod return schema — validates at runtime and generates @returns JSDoc,
// so the LLM's generated code gets real typed objects
function searchUsers(query: string): Array<{ name: string; email: string; score: number }> {
  const users = [
    { name: 'Alice', email: 'alice@example.com', score: 0.95 },
    { name: 'Bob', email: 'bob@example.com', score: 0.8 },
  ];
  return users.filter((u) => u.name.toLowerCase().includes(query.toLowerCase()));
}
tool(searchUsers, {
  description: 'Search users by name or email',
  args: [['query', 'Search query string']],
  returns: z
    .array(z.object({ name: z.string(), email: z.string(), score: z.number() }))
    .describe('Matching users with relevance scores'),
});

function sendEmail(to: string, subject: string, body: string): string {
  return `[mock] Email sent to ${to}: ${subject} — ${body}`;
}
tool(sendEmail, { returns: 'Confirmation message' });

// toolEval lets the LLM write a JS function body that orchestrates
// multiple tools in a single turn — no round-trip overhead per tool call.

const exec = toolEval(add, multiply, searchUsers, sendEmail);

const { data } = await prompt`
  Search for "Alice", multiply her relevance score by 100,
  then send her an email with the result as the subject.
  ${exec}
`();

console.log(`\nResult: ${data}`);
