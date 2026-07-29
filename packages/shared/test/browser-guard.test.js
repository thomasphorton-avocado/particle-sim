import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const sharedSrcRoot = path.resolve(currentDir, "..", "src");

function collectSourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (/\.(ts|js)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const forbiddenTokens = [
  "window",
  "document",
  "HTMLElement",
  "Navigator",
  "localStorage",
  "sessionStorage",
  "matchMedia",
  "requestAnimationFrame",
];

test("shared gameplay packages stay browser-agnostic", () => {
  const files = collectSourceFiles(sharedSrcRoot);
  const offenders = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sanitized = stripComments(source);

    for (const token of forbiddenTokens) {
      const pattern = new RegExp(`\\b${token}\\b`);
      if (pattern.test(sanitized)) {
        offenders.push(`${path.relative(sharedSrcRoot, file)} -> ${token}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `Found browser-only globals in shared gameplay packages:\n${offenders.join("\n")}`);
});
