#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP_DIR = "src/lib/backend/desktop/";
const EXPECTED_COMMAND_NAMES = [
  "app_quit",
  "chat_session_delete", "chat_session_load", "chat_session_rename",
  "chat_session_save", "chat_sessions_list", "fs_create_dir", "fs_create_file",
  "fs_delete", "fs_list_dir", "fs_read_file", "fs_read_file_base64", "fs_rename",
  "fs_write_file", "list_custom_pets", "open_external", "open_html_preview",
  "pet_window_hide",
  "pet_window_prewarm",
  "pet_window_set_position", "pet_window_show", "pet_window_toggle", "pi_cli",
  "pi_cli_update_check", "pi_fetch_models", "pi_generate_title", "pi_send",
  "pi_settings_read", "pi_settings_write", "pi_start", "pi_stop", "project_open", "project_open_remote",
  "mcp_adapter_check", "mcp_config_discover", "mcp_config_open_dir", "mcp_config_read", "mcp_config_write",
  "project_resolve",
  "project_pick", "project_remove_recent", "projects_recent", "runtime_config_read",
  "provider_auth_answer", "provider_auth_begin", "provider_auth_cancel",
  "provider_auth_list", "provider_auth_logout",
  "runtime_config_write", "workspace_root", "wsl_list_distros",
  "wsl_runtime_validate", "wsl_shell_bridge_path",
  "skills_cli", "skills_search",
  "remote_control_disable", "remote_control_enable", "remote_control_pairing_payload",
  "remote_control_private_addresses", "remote_control_reset_identity",
  "remote_control_revoke_device", "remote_control_status", "remote_conversation_append",
  "remote_conversation_archive", "remote_conversation_cancel", "remote_conversation_get",
  "remote_conversation_messages", "remote_conversations_list",
  // Remote Agent (SSH execution) shipped without updating this list, so the
  // check was failing on a clean tree for reasons unrelated to any new change.
  "remote_launcher_autoupgrade",
  "remote_profile_capabilities", "remote_profile_check_draft", "remote_profile_delete",
  "remote_profile_install_launcher", "remote_profile_preflight",
  "remote_profile_save", "remote_profiles_list", "ssh_config_hosts",
  // Remote provider sync: identifiers in, redacted previews out. Provider JSON
  // and credentials stay behind these three commands.
  "remote_provider_sync_apply", "remote_provider_sync_candidates",
  "remote_provider_sync_prepare", "remote_task_ensure",
  "remote_task_status", "remote_task_stop", "remote_task_reap",
  // Read-only remote workspace browsing (V2.3).
  "remote_workspace_request",
].sort();
const EXPECTED_PI_EVENTS = ["pi://exit", "pi://line", "pi://stderr"];

export function collectBackendInventory(repoRoot = REPO_ROOT) {
  const files = walk(path.join(repoRoot, "src"))
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file))
    .map((file) => normalizePath(path.relative(repoRoot, file)));
  const tauriRefs = [];
  const legacyTauriRefs = [];
  const commandCalls = [];
  const leakedCommandLiterals = [];
  const forbiddenDesktopImports = [];
  const forbiddenPlatformGuesses = [];
  const forbiddenDynamicCoreImports = [];
  const piEvents = new Set();

  for (const file of files) {
    const content = readRepoFile(repoRoot, file);
    for (const match of content.matchAll(/@tauri-apps\/[A-Za-z0-9_/@.-]+/g)) {
      const entry = { file, specifier: match[0] };
      tauriRefs.push(entry);
      if (!file.startsWith(DESKTOP_DIR)) legacyTauriRefs.push(entry);
    }

    /*
     * Outside the adapter directory `desktopInvoke` is the only legal spelling,
     * and the leaked-literal rule below enforces that. Inside it, a command may
     * also be reached through an injected `invoke` — DesktopPiProcessPort takes
     * one so its tests can substitute a fake — which is how pi_start, pi_send,
     * and pi_stop went missing from this inventory while still being called.
     */
    const commandCall = file.startsWith(DESKTOP_DIR)
      ? /(?:desktopInvoke|invoke)(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g
      : /desktopInvoke(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g;
    for (const match of content.matchAll(commandCall)) {
      commandCalls.push({ file, command: match[1] });
    }

    if (!file.startsWith(DESKTOP_DIR)) {
      for (const command of EXPECTED_COMMAND_NAMES) {
        const quoted = new RegExp(`["']${escapeRegExp(command)}["']`);
        if (quoted.test(content)) leakedCommandLiterals.push({ file, command });
      }
    }

    if (/^src\/(?:app|components|lib\/pi)\//.test(file)) {
      for (const match of content.matchAll(
        /(?:from\s+|import\s*\()\s*["']([^"']*backend\/desktop[^"']*)["']/g,
      )) {
        forbiddenDesktopImports.push({ file, specifier: match[1] });
      }
    }

    if (/^src\/lib\/(?:pi|workspace\.ts|store\.ts)/.test(file)) {
      for (const marker of ["isTauri(", "__TAURI_INTERNALS__"]) {
        if (content.includes(marker)) forbiddenPlatformGuesses.push({ file, marker });
      }
      /*
       * `typeof window` is only a platform guess when it stands in for "am I in
       * Tauri?" — that question belongs to the backend ports, which is what this
       * rule protects. Comparing against "undefined" asks a different one: "has
       * the DOM been created yet?" This app static-exports, so core stores are
       * evaluated in Node during prerender and a theme default or a matchMedia
       * read has to survive that. Banning the whole spelling made the rule
       * unsatisfiable for SSR-safe code and left a standing violation instead of
       * a signal, so match the bare form only.
       */
      const withoutSsrGuards = content.replace(
        /typeof\s+window\s*[!=]==\s*["']undefined["']/g,
        "",
      );
      if (withoutSsrGuards.includes("typeof window")) {
        forbiddenPlatformGuesses.push({ file, marker: "typeof window" });
      }
    }

    if (/^src\/lib\/(?:pi\/(?:chat|sessions)|workspace)\.ts$/.test(file)) {
      for (const match of content.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
        if (/(?:\.\/chat|\.\/sessions|\.\.\/workspace)$/.test(match[1])) {
          forbiddenDynamicCoreImports.push({ file, specifier: match[1] });
        }
      }
    }

    for (const match of content.matchAll(/["'](pi:\/\/(?:line|stderr|exit))["']/g)) {
      piEvents.add(match[1]);
    }
  }

  const commandNames = [...new Set(commandCalls.map((call) => call.command))].sort();
  return {
    legacyTauriFileCount: new Set(legacyTauriRefs.map((entry) => entry.file)).size,
    legacyTauriRefCount: legacyTauriRefs.length,
    legacyTauriRefs,
    tauriRefCount: tauriRefs.length,
    tauriRefs,
    coreImportCount: tauriRefs.filter((entry) => entry.specifier === "@tauri-apps/api/core").length,
    commandCallCount: commandCalls.length,
    commandUniqueCount: commandNames.length,
    commandNames,
    commandCalls,
    leakedCommandLiterals,
    forbiddenDesktopImports,
    forbiddenPlatformGuesses,
    forbiddenDynamicCoreImports,
    piEvents: [...piEvents].sort(),
  };
}

export function validateInventory(inventory = collectBackendInventory()) {
  const errors = validateStrict(inventory);
  if (JSON.stringify(inventory.commandNames) !== JSON.stringify(EXPECTED_COMMAND_NAMES)) {
    const actual = new Set(inventory.commandNames);
    const expected = new Set(EXPECTED_COMMAND_NAMES);
    const missing = EXPECTED_COMMAND_NAMES.filter((name) => !actual.has(name));
    const extra = inventory.commandNames.filter((name) => !expected.has(name));
    if (missing.length) errors.push(`desktop adapter commands missing: ${missing.join(", ")}`);
    if (extra.length) errors.push(`unexpected desktop adapter commands: ${extra.join(", ")}`);
  }
  if (JSON.stringify(inventory.piEvents) !== JSON.stringify(EXPECTED_PI_EVENTS)) {
    errors.push(`expected Pi events ${EXPECTED_PI_EVENTS.join(", ")}, found ${inventory.piEvents.join(", ")}`);
  }
  return errors;
}

export function validateStrict(inventory = collectBackendInventory()) {
  const errors = inventory.legacyTauriRefs.map(
    (ref) => `${ref.file} imports ${ref.specifier}`,
  );
  for (const leak of inventory.leakedCommandLiterals) {
    errors.push(`${leak.file} contains desktop command literal ${leak.command}`);
  }
  for (const entry of inventory.forbiddenDesktopImports) {
    errors.push(`${entry.file} imports desktop adapter ${entry.specifier}`);
  }
  for (const entry of inventory.forbiddenPlatformGuesses) {
    errors.push(`${entry.file} contains platform guess ${entry.marker}`);
  }
  for (const entry of inventory.forbiddenDynamicCoreImports) {
    errors.push(`${entry.file} dynamically imports core peer ${entry.specifier}`);
  }
  errors.push(...validateContracts(REPO_ROOT));
  return errors;
}

function validateContracts(repoRoot) {
  const contractsRoot = path.join(repoRoot, "packages", "remote-control-contracts", "src");
  if (!fs.existsSync(contractsRoot)) return ["remote-control contracts package is missing"];
  const source = walk(contractsRoot)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  const errors = [];
  for (const forbidden of [
    "@tauri-apps/", "zustand", "react", "sessionPath", "PiCommand", "Bash", "../../src/",
  ]) {
    if (source.includes(forbidden)) errors.push(`contracts contain forbidden dependency/field ${forbidden}`);
  }
  return errors;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(fullPath));
    else out.push(fullPath);
  }
  return out;
}

function readRepoFile(repoRoot, file) {
  return fs.readFileSync(path.join(repoRoot, file), "utf8");
}

function normalizePath(file) {
  return file.split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function printSummary(inventory) {
  console.log(`legacy Tauri inventory: ${inventory.legacyTauriFileCount} files, ${inventory.legacyTauriRefCount} refs`);
  console.log(`desktop adapter command inventory: ${inventory.commandCallCount} mappings, ${inventory.commandUniqueCount} unique commands`);
  console.log(`Pi events: ${inventory.piEvents.join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = new Set(process.argv.slice(2));
  const inventory = collectBackendInventory();
  const errors = args.has("--strict") ? validateStrict(inventory) : validateInventory(inventory);
  if (args.has("--json")) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors, inventory }, null, 2));
  } else {
    printSummary(inventory);
    for (const error of errors) console.error(`backend boundary check failed: ${error}`);
  }
  process.exitCode = errors.length === 0 ? 0 : 1;
}
