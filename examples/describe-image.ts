import "./env.js";
import { readFileSync } from "node:fs";
import { prompt } from "../src/index.js";
import { resolve } from "node:path";

const image = readFileSync(resolve(import.meta.dirname, "./image.png"));

await prompt`Describe this image: ${image}`();
