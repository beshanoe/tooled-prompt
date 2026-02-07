import "./env.js";
import { prompt, store } from "../src/index.js";
import { execSync } from "child_process";
import * as fs from "fs/promises";
import { z } from "zod";

function gitLog(count: string) {
  try {
    return execSync(
      `git log --oneline --no-decorate -n ${parseInt(count, 10)}`,
      { encoding: "utf-8" },
    );
  } catch (err: any) {
    return `Failed to read git log: ${err.message}`;
  }
}

function readFile(filePath: string) {
  return fs
    .readFile(filePath, "utf-8")
    .catch((err) => `Failed to read ${filePath}: ${err.message}`);
}

const changelogSchema = z.object({
  projectName: z.string().describe("Name of the project"),
  summary: z.string().describe("Brief overall summary of changes"),
  categories: z
    .array(
      z.object({
        name: z.enum(["Features", "Fixes", "Refactoring", "Docs", "Other"]),
        entries: z.array(
          z.object({
            commit: z.string().describe("Short commit hash"),
            description: z
              .string()
              .describe("Human-readable description of the change"),
          }),
        ),
      }),
    )
    .describe("Changes grouped by category"),
});

const changeLog = store(changelogSchema);

await prompt`
  Use ${gitLog} to read the last 20 commits, then use ${readFile} to read
  "README.md" for project context.

  Generate a structured CHANGELOG grouped by category (Features, Fixes,
  Refactoring, Docs, Other). Each entry should have a clear, human-readable
  description derived from the commit message.

  Save the result in ${changeLog}. Don't output anything else.
`();


const result = changeLog.get();
if (!result) {
  console.error("LLM did not store a changelog.");
  process.exit(1);
}

// use console.table for a nice output format
console.log(`\nChangelog for ${result.projectName}:\n`);
console.log(`Summary: ${result.summary}\n`);
result.categories.forEach((category) => {
  console.log(`## ${category.name}`);
  console.table(
    category.entries.map((entry) => ({
      Commit: entry.commit,
      Description: entry.description,
    })),
  );
});
