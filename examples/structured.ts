/**
 * Structured Output Example - Using Zod schemas for typed responses
 *
 * Run with: npx tsx examples/structured.ts
 */

import "./env.js";
import { z } from "zod";
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

const summarySchema = z.object({
  overallSummary: z.string().describe("Overall summary of the project"),
  fileSummaries: z
    .array(
      z.object({
        filePath: z.string().describe("Path of the file"),
        summary: z.string().describe("Brief summary of the file contents"),
      }),
    )
    .describe("Summaries for each TypeScript file in the project"),
});

const { data } = await prompt`
  Summarize the TypeScript files in this project.

  Use ${readDir} to list the files, then for each file:
  1. Use ${readFile} to read it
  2. Provide a brief summary of what it does

  Save your analysis in ${prompt.return}.
`(summarySchema);

console.log({ data });
