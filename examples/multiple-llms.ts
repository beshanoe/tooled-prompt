import "./env.js";
import { createTooledPrompt } from "../src/index.js";
import { resolve } from "path";
import * as fs from "fs/promises";
import z from "zod";

// LLM that is good at describing images
const imageLlm = createTooledPrompt({
  apiUrl: process.env.TOOLED_PROMPT_LLM_URL,
  modelName: "gemma-3-27b-it-q4",
});

// LLM that is good at reasoning and using tools
const toolLlm = createTooledPrompt({
  apiUrl: process.env.TOOLED_PROMPT_LLM_URL,
  modelName: "glm4-flash-tool",
  showThinking: true,
});

function readDir() {
  return fs.readdir(import.meta.dirname);
}

async function describeImage(imageName: string) {
  const image = await fs.readFile(resolve(import.meta.dirname, imageName));

  const { data } = await imageLlm.prompt`Describe this image: ${image}`();
  return data;
}

const { data } = await toolLlm.prompt`
    - Find all the images in folder using ${readDir}.
    - Describe each image using ${describeImage}.

    - Output to ${toolLlm.prompt.return}
`(
  z.object({
    images: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
      }),
    ),
  }),
);

data.images.forEach((image) => {
  console.log(`Image: ${image.name}`);
  console.log(`Description: ${image.description}`);
  console.log("-----");
});
