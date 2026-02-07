import "./env.js";
import { prompt } from "tooled-prompt";
import * as fs from "fs/promises";

function readPackageJson(filePath: string) {
  return fs.readFile(filePath, "utf-8").catch(
    (err) => `Failed to read ${filePath}: ${err.message}`,
  );
}

function checkPackage(packageName: string) {
  return fetch(`https://registry.npmjs.org/${packageName}/latest`)
    .then((r) => (r.ok ? r.json() : r.text().then((t) => `npm registry error: ${t}`)))
    .then((data) => JSON.stringify(data, null, 2))
    .catch((err) => `Failed to check ${packageName}: ${err.message}`);
}

const result = await prompt`
  Use ${readPackageJson} to read "package.json" in the current directory.

  Then for each dependency (both dependencies and devDependencies), use
  ${checkPackage} to look up the latest version on the npm registry.

  Report which packages are outdated and whether each update would be a
  patch, minor, or major version bump. Include a risk assessment for each.
`();
