import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function findTestFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findTestFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [entryPath] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

const testFiles = findTestFiles(path.resolve(process.cwd(), "tests"));
if (testFiles.length === 0) {
  throw new Error("No tests/**/*.test.ts files were found.");
}

const result = spawnSync(process.execPath, [
  "--import",
  "tsx",
  "--test",
  ...testFiles,
], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;
