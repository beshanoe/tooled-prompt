/**
 * Simple Example - Minimal styled-prompt demonstration
 *
 * Run with: npx tsx examples/simple.ts
 */

import "./env.js";
import { prompt, tool } from "../src/index.js";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Read a file's contents
 */
async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8");
}

tool(readFile, {
  description: "Read a file's contents",
  args: ["Path to the file to read"],
});

/**
 * Read the list of TypeScript files in src directory
 */
async function readDir(): Promise<string[]> {
  const files = await fs.readdir("src", { recursive: true });
  return files
    .filter((file) => file.endsWith(".ts"))
    .map((file) => path.resolve("src", file));
}

tool(readDir, { description: "List TypeScript files in the src directory" });

async function main() {
  const { data } = await prompt`
    Summarize the TypeScript files in this project.

    Use ${readDir} to list the files, then for each file:
    1. Use ${readFile} to read it
    2. Provide a brief summary of what it does
  `();

  console.log("\n=== Summary ===");
  console.log(data);
}

main().catch(console.error);
