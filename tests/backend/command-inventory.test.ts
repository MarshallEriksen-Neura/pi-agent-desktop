import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

interface InventoryResult {
  ok: boolean;
  errors: string[];
  inventory: {
    legacyTauriFileCount: number;
    legacyTauriRefCount: number;
    coreImportCount: number;
    tauriRefCount: number;
    commandCallCount: number;
    commandUniqueCount: number;
    commandNames: string[];
    piEvents: string[];
  };
}

function inventory(): InventoryResult {
  const raw = execFileSync(
    process.execPath,
    ["scripts/check-backend-boundaries.mjs", "--inventory", "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    }
  );
  return JSON.parse(raw) as InventoryResult;
}

test("locks the strict desktop adapter boundary and command inventory", () => {
  const result = inventory();
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.inventory.legacyTauriFileCount, 0);
  assert.equal(result.inventory.legacyTauriRefCount, 0);
  assert.ok(result.inventory.tauriRefCount > 0);
  assert.ok(result.inventory.commandCallCount >= 64);
  assert.equal(result.inventory.commandUniqueCount, 62);
});

test("locks the desktop command names and Pi process event names", () => {
  const result = inventory();
  assert.deepEqual(result.inventory.piEvents, ["pi://exit", "pi://line", "pi://stderr"]);
  assert.deepEqual(result.inventory.commandNames, [
    "chat_session_delete",
    "chat_session_load",
    "chat_session_rename",
    "chat_session_save",
    "chat_sessions_list",
    "fs_create_dir",
    "fs_create_file",
    "fs_delete",
    "fs_list_dir",
    "fs_read_file",
    "fs_read_file_base64",
    "fs_rename",
    "fs_write_file",
    "list_custom_pets",
    "mcp_adapter_check",
    "mcp_config_discover",
    "mcp_config_open_dir",
    "mcp_config_read",
    "mcp_config_write",
    "open_external",
    "pet_window_hide",
    "pet_window_set_position",
    "pet_window_show",
    "pet_window_toggle",
    "pi_cli",
    "pi_cli_update_check",
    "pi_fetch_models",
    "pi_generate_title",
    "pi_send",
    "pi_settings_read",
    "pi_settings_write",
    "pi_start",
    "pi_stop",
    "project_open",
    "project_pick",
    "project_remove_recent",
    "project_resolve",
    "projects_recent",
    "provider_auth_answer",
    "provider_auth_begin",
    "provider_auth_cancel",
    "provider_auth_list",
    "provider_auth_logout",
    "remote_control_disable",
    "remote_control_enable",
    "remote_control_pairing_payload",
    "remote_control_private_addresses",
    "remote_control_reset_identity",
    "remote_control_revoke_device",
    "remote_control_status",
    "remote_conversation_append",
    "remote_conversation_archive",
    "remote_conversation_cancel",
    "remote_conversation_get",
    "remote_conversation_messages",
    "remote_conversations_list",
    "runtime_config_read",
    "runtime_config_write",
    "workspace_root",
    "wsl_list_distros",
    "wsl_runtime_validate",
    "wsl_shell_bridge_path",
  ]);
});
