#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = path.join(root, "packages", "remote-control-contracts");
const targetDir = path.join(root, ".tmp", "remote-control", "stage1-target");
fs.mkdirSync(targetDir, { recursive: true });

const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) {
  console.error(`Stage 1 evaluator: missing TypeScript compiler at ${tsc}`);
  process.exit(1);
}

run(process.execPath, [tsc, "-p", path.join(contracts, "tsconfig.json"), "--noEmit"], root);

const cargoEnv = {
  ...process.env,
  CARGO_TARGET_DIR: targetDir,
};
run("rustup", [
  "run",
  "1.77.2",
  "cargo",
  "test",
  "--manifest-path",
  "crates/pi-remote-control/Cargo.toml",
  "--locked",
], root, cargoEnv);
run("git", ["diff", "--check"], root);
run(process.execPath, ["scripts/check-remote-control-stage0.mjs"], root);

console.log("remote-control Stage 1: contracts, Rust domain tests, MSRV and diff checks passed");

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
