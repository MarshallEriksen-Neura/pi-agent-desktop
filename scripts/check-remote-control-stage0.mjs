#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contracts = path.join(root, "packages", "remote-control-contracts");
const remoteCrate = path.join(root, "crates", "pi-remote-control");
const fixtureRoot = path.join(contracts, "fixtures", "v1");
const errors = [];
const parsedFixtures = new Map();

const expectedFixtures = [
  "pairing/qr-payload.json",
  "pairing/request.json",
  "pairing/success.json",
  "pairing/failure-invalid-ticket.json",
  "projects/summary.json",
  "projects/tree-page.json",
  "projects/capabilities.json",
  "tasks/create-request.json",
  "tasks/create-request-extended.json",
  "tasks/snapshot-awaiting-input.json",
  "tasks/error-project-revoked.json",
  "tasks/interaction-request.json",
  "tasks/interaction-response.json",
  "tasks/interaction-expired.json",
  "events/task-created.json",
  "events/task-state-awaiting-input.json",
  "events/interaction-requested.json",
  "events/snapshot-required.json",
  "events/event-backpressure.json",
  "errors/policy-violations.json",
];

for (const relative of expectedFixtures) {
  const file = path.join(fixtureRoot, relative);
  if (!fs.existsSync(file)) {
    errors.push(`missing shared fixture: ${relative}`);
    continue;
  }
  try {
    parsedFixtures.set(relative, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    errors.push(`invalid JSON fixture ${relative}: ${error.message}`);
  }
}

const exactFields = [
  ["pairing/qr-payload.json", "protocol", "pi.remote-control"],
  ["pairing/qr-payload.json", "version", 1],
  ["pairing/qr-payload.json", "certificatePin.algorithm", "spki-sha256"],
  ["pairing/failure-invalid-ticket.json", "error", "invalid_ticket"],
  ["projects/tree-page.json", "entries.0.kind", "directory"],
  ["projects/tree-page.json", "entries.1.kind", "file"],
  ["projects/capabilities.json", "fileBodyAvailable", false],
  ["tasks/create-request-extended.json", "executionProfile", "extended"],
  ["tasks/snapshot-awaiting-input.json", "state", "awaiting_input"],
  ["tasks/error-project-revoked.json", "code", "project_revoked"],
  ["tasks/interaction-request.json", "kind", "select"],
  ["tasks/interaction-expired.json", "status", "expired"],
  ["events/task-created.json", "kind", "task.created"],
  ["events/task-state-awaiting-input.json", "to", "awaiting_input"],
  ["events/interaction-requested.json", "kind", "interaction.requested"],
  ["events/snapshot-required.json", "kind", "snapshot_required"],
  ["events/event-backpressure.json", "kind", "event_backpressure"],
];

for (const [relative, field, expected] of exactFields) {
  const actual = field.split(".").reduce((value, part) => value?.[part], parsedFixtures.get(relative));
  if (actual !== expected) {
    errors.push(`fixture discriminant mismatch ${relative} ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

for (const file of walk(path.join(contracts, "src"))) {
  if (!file.endsWith(".ts")) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const forbidden of ["@tauri-apps/", "react", "zustand", "../../../src/", "sessionPath", "PiCommand", "Bash"]) {
    if (source.includes(forbidden)) errors.push(`contracts/mobile source contains forbidden ${forbidden}: ${path.relative(root, file)}`);
  }
}

for (const file of [path.join(remoteCrate, "Cargo.toml"), ...walk(path.join(remoteCrate, "src"))]) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (/(?:^|\n)\s*(?:tauri(?:-[A-Za-z0-9_-]+)?\s*=|use\s+tauri|extern\s+crate\s+tauri)/m.test(source)) {
    errors.push(`remote-control crate crosses Tauri boundary: ${path.relative(root, file)}`);
  }
}

if (!fs.existsSync(path.join(remoteCrate, "tests", "fixtures_roundtrip.rs"))) {
  errors.push("missing Rust fixture round-trip test");
}

if (errors.length) {
  for (const error of errors) console.error(`remote-control Stage 0: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`remote-control Stage 0: ${expectedFixtures.length} shared fixtures and Tauri-free boundaries verified`);
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}
