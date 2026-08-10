#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriRoot = path.join(repoRoot, "src-tauri");
const coreManifest = path.join(repoRoot, "crates", "pi-backend-core", "Cargo.toml");
const evaluatorEnv = {
  ...process.env,
  CARGO_TARGET_DIR: path.join(os.tmpdir(), "ragcode-pi-backend-resilience-target"),
};

assertRustTests([
  "pi_process::tests::builds_compatible_rpc_command",
  "pi_process::tests::frames_one_bounded_json_line",
  "pi_process::tests::rejects_oversized_input",
  "pi_process::tests::drains_after_rejecting_oversized_output",
  "pi_process::tests::natural_exit_is_reported_once",
  "pi_process::tests::stop_is_idempotent_and_bounded",
  "pi_process::tests::windows_job_closes_descendant_tree",
  "chat_store::tests::configures_and_migrates_database_transactionally",
  "chat_store::tests::rejects_oversized_session_payload",
  "projects::tests::corrupt_state_fails_closed_without_overwrite",
  "projects::tests::rejects_state_larger_than_the_read_limit",
  "projects::tests::state_writes_are_atomic_and_serialized",
  "projects::tests::independent_store_instances_preserve_concurrent_updates",
  "projects::tests::rejects_unsafe_relative_paths_and_symlink_escape",
  "backend_lifecycle::tests::shutdown_is_ordered_and_bounded",
  "backend_lifecycle::tests::rejects_a_hook_that_overruns_its_deadline",
  "backend_health::tests::health_snapshot_redacts_sensitive_values",
  "pi_process::tests::blocked_event_sink_does_not_block_stop",
]);

run("cargo", ["test", "--manifest-path", coreManifest, "--", "--test-threads=1"], repoRoot);
run("cargo", ["check", "--lib", "--bins"], tauriRoot);
run("cargo", ["fmt", "--manifest-path", coreManifest, "--", "--check"], repoRoot);
run(
  "rustfmt",
  [
    "--edition",
    "2021",
    "--config",
    "skip_children=true",
    "--check",
    "src/chat_store.rs",
    "src/fs_bridge.rs",
    "src/lib.rs",
    "src/pi_bridge.rs",
    "src/projects.rs",
    "src/wsl.rs",
  ],
  tauriRoot,
);
run(process.execPath, ["scripts/check-backend-boundaries.mjs"], repoRoot);

function assertRustTests(expected) {
  const result = spawnSync("cargo", ["test", "--manifest-path", coreManifest, "--", "--list"], {
    cwd: repoRoot,
    env: evaluatorEnv,
    encoding: "utf8",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  const listed = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/: test$/, "").trim())
      .filter(Boolean),
  );
  const missing = expected.filter((name) => !listed.has(name));
  if (missing.length > 0) {
    console.error(`backend resilience evaluator is missing required tests:\n${missing.join("\n")}`);
    process.exit(1);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: evaluatorEnv,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
