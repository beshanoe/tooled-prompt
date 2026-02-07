import "./env.js";
import { prompt } from "../src/index.js";

// Define a tool function
function getWeather(cityName: string, unit = "fahrenheit"): string {
  return `Weather in ${cityName}: Sunny, 72° (${unit})`;
}

// Use it in a prompt - tools are auto-detected!
const { data } = await prompt`
  What's the weather like in San Francisco?
  Use ${getWeather} to find out.
`();

console.log(`\nResult: ${data}`);
