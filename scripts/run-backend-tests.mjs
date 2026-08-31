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
rewriteAliases(outDir, path.join(outDir, "src"));

// Two entries, two processes. `isolated.test.js` holds specs whose setup is not
// reversible in-process: they call the chat store's `init()`, which registers a
// subscriber on the global ext-ui store that nothing unsubscribes — clearing the
// chat-store map leaves it alive, holding a closure over a client the spec then
// disposes, and a later unrelated spec inherits it and hangs.
//
// Both entries always run: bailing out after the first would let a failure there
// hide whatever the second would have reported.
const entries = [
  ".tmp/backend-tests/tests/backend/all.test.js",
  ".tmp/backend-tests/tests/backend/isolated.test.js",
];
let failed = false;
for (const entry of entries) {
  if (!runAllowingFailure(process.execPath, ["--test", entry])) failed = true;
}
if (failed) process.exit(1);

/**
 * tsc type-checks `@/*` through tsconfig paths but emits the specifier verbatim,
 * so plain-CommonJS output hits MODULE_NOT_FOUND the moment a test's import
 * graph reaches one. Rewrite them to relative paths post-emit — cheaper than
 * adding a resolver hook, and keeps `node --test` invocable by hand.
 */
function rewriteAliases(dir, srcRoot) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // srcRoot is threaded through rather than derived from `dir`: deriving it
      // per level made it `<dir>/src` at every depth, so a rewrite one level
      // down resolved against `src/lib/pi/src` and emitted `./src/lib/...`.
      rewriteAliases(full, srcRoot);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const before = fs.readFileSync(full, "utf8");
    const after = before.replace(/require\("@\/([^"]+)"\)/g, (_m, sub) => {
      let rel = path
        .relative(path.dirname(full), path.join(srcRoot, sub))
        .split(path.sep)
        .join("/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `require("${rel}")`;
    });
    if (after !== before) fs.writeFileSync(full, after);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Same, but reports the outcome instead of exiting, so later entries still run. */
function runAllowingFailure(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status === 0;
}
