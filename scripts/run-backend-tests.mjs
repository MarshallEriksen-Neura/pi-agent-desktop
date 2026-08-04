#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(repoRoot, ".tmp", "backend-tests");
const tmpRoot = path.resolve(repoRoot, ".tmp");

if (!outDir.startsWith(tmpRoot + path.sep)) {
  throw new Error(`refusing to remove unexpected backend test output: ${outDir}`);
}

fs.rmSync(outDir, { recursive: true, force: true });

run(process.execPath, [
  path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
  "-p",
  "tests/backend/tsconfig.json",
]);
run(process.execPath, ["--test", ".tmp/backend-tests/tests/backend/all.test.js"]);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
