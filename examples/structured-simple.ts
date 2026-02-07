import "./env.js";
import { z } from "zod";
import { prompt } from "../src/index.js";

const mathSchema = z.object({
  answer: z.number(),
  explanation: z.string()
});

const { data } = await prompt`What is 2 + 2? Explain like Gottlob Frege would do in one short tweet with hashtags`(mathSchema);

console.log("\n=== Result ===");
console.log("Answer:", data.answer);
console.log("Explanation:", data.explanation);