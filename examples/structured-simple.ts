import "./env.js";
import { prompt } from "../src/index.js";

const { data } =
  await prompt`What is 2 + 2? Explain like Gottlob Frege would do in one short tweet with hashtags`(
    {
      answer: "Answer to the question",
      explanation: "Explanation of the answer",
    },
  );

console.log("\n=== Result ===");
console.log("Answer:", data.answer);
console.log("Explanation:", data.explanation);
