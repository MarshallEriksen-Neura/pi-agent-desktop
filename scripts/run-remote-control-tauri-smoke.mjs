#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep the large Cargo target on the workspace volume. The host C: drive is
// reserved for the toolchain and user profile, not rebuild artifacts.
const target = path.join(root, ".tmp", "remote-control", "tauri-smoke-target");
const dataDir = path.join(
  root,
  ".tmp",
  "remote-control",
  `tauri-smoke-data-${process.pid}`,
);
const tempDir = path.join(root, ".tmp", "remote-control", "temp");
fs.mkdirSync(tempDir, { recursive: true });
const result = spawnSync(
  "rustup",
  [
    "run",
    "1.77.2",
    "cargo",
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--features",
    "remote-control-smoke",
    "--bin",
    "remote-control-command-smoke",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: target,
      RAGCODE_REMOTE_CONTROL_DATA_DIR: dataDir,
      RAGCODE_DESKTOP_STATE_PATH: path.join(dataDir, "desktop.json"),
      TEMP: tempDir,
      TMP: tempDir,
    },
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(
  "remote-control Tauri command smoke: current-project sync -> enable -> project switch -> shutdown -> stable startup restore -> disable -> corrupt-config fail-closed passed",
);
