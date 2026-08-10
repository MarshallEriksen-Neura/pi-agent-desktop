#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmInvocation = process.platform === "win32"
  ? {
      command: process.execPath,
      prefix: [path.join(process.env.APPDATA ?? "", "npm", "node_modules", "pnpm", "bin", "pnpm.mjs")],
    }
  : { command: "pnpm", prefix: [] };

run(pnpmInvocation.command, [...pnpmInvocation.prefix, "--filter", "@pi/remote-control-contracts", "typecheck"], root);
run(pnpmInvocation.command, [...pnpmInvocation.prefix, "exec", "tsc", "-p", "tests/remote-control-stage0/tsconfig.json", "--noEmit"], root);
run(process.execPath, ["scripts/check-remote-control-stage0.mjs"], root);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
