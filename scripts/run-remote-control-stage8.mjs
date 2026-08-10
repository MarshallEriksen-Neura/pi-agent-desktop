#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
const composition = fs.readFileSync(
  path.join(root, "src-tauri", "src", "remote_control", "mod.rs"),
  "utf8",
);
const targetDir = path.join(root, ".tmp", "remote-control", "stage8-target");
fs.mkdirSync(targetDir, { recursive: true });

const requiredLibMarkers = [
  "mod remote_control;",
  ".manage(RemoteControlState::default())",
  "app.state::<RemoteControlState>().shutdown();",
  "remote_control::remote_control_enable",
  "remote_control::remote_control_reset_identity",
];
const requiredCompositionMarkers = [
  "RemoteControlConfig::try_new(true",
  "GatewayState::with_runtime_config_and_storage",
  "GatewayServer::start",
  "remote_control_pairing_payload",
  "remote_control_allow_project",
  "remote_control_revoke_device",
  "remote_control_reset_identity",
  "gateway.supervisor.stop();",
  "rotate_identity(",
  "storage.clear_devices()",
  "identity and authorization epochs differ",
];
for (const marker of requiredLibMarkers) assertMarker(lib, marker);
for (const marker of requiredCompositionMarkers) assertMarker(composition, marker);
assertSectionMarker(
  composition,
  "fn reset_identity<R: Runtime>",
  "fn with_gateway<T>",
  ".operation\n            .lock()",
);
if (composition.includes("pi_start") || composition.includes("pi_send")) {
  throw new Error("remote-control composition must not call desktop Pi RPC commands");
}

if (process.platform === "win32") {
  run("cmd.exe", ["/d", "/s", "/c", "pnpm test:remote-control-stage7"], root);
} else {
  run("pnpm", ["test:remote-control-stage7"], root);
}
run(
  "rustup",
  [
    "run",
    "1.77.2",
    "cargo",
    "test",
    "--manifest-path",
    "crates/pi-remote-control/Cargo.toml",
    "--locked",
    "--test",
    "stage8_lifecycle",
  ],
  root,
  { ...process.env, CARGO_TARGET_DIR: targetDir },
);
run(
  "rustup",
  ["run", "1.77.2", "cargo", "check", "--manifest-path", "src-tauri/Cargo.toml", "--locked"],
  root,
  { ...process.env, CARGO_TARGET_DIR: targetDir },
);
run(
  "rustup",
  ["run", "1.77.2", "cargo", "fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"],
  root,
);
run("git", ["diff", "--check"], root);
console.log("remote-control Stage 8: Tauri composition, lifecycle wiring, persistence restore and gateway regressions passed");

function assertMarker(text, marker) {
  if (!text.includes(marker)) throw new Error(`Stage 8 composition marker missing: ${marker}`);
}

function assertSectionMarker(text, startMarker, endMarker, marker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || !text.slice(start, end).includes(marker)) {
    throw new Error(`Stage 8 section marker missing: ${marker}`);
  }
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
