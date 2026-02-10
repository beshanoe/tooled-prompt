import "./env.js";
import { prompt } from "../src/index.js";
import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
let nextTurn = prompt;

while (true) {
  let userInput: string;
  try {
    userInput = await rl.question("> ");
  } catch {
    break;
  }
  if (!userInput.trim()) continue;

  const { next } = await nextTurn`${userInput}`();
  console.log();

  nextTurn = next;
}
