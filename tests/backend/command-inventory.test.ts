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
  assert.ok(result.inventory.commandCallCount >= 65);
  // 62 was stale before this suite could run: pet_window_prewarm had been
  // invoked since the pet feature landed without being added to the boundary
  // script's expected list, so the real count was already 63. app_quit makes 64.
  // skills_cli (the `npx skills` bridge) makes 66, skills_search 67. Remote
  // Agent's 7 (remote_profile_* and ssh_config_hosts) had the same drift and
  // made 74; provider sync's 3 make 77. remote_profile_capabilities — the
  // launcher capability handshake — makes 78. remote_workspace_request, the
  // read-only remote browsing bridge, makes 79. project_open_remote — recording a
  // project opened on an SSH host — makes 80. remote_task_ensure, which mints or
  // reattaches a detached task before pi_start attaches to it, makes 81.
  // The detached task lifecycle adds three more — status, stop and reap are separate
  // because they are separate intents: asking, ending the work, and housekeeping.
  // remote_launcher_autoupgrade makes 85: it is the first caller the capability
  // handshake ever had, and it is separate from install because it decides *whether*
  // to install rather than doing it on request. The isolated remote PTY capability
  // adds start, write, resize, and stop, bringing the command inventory to 89.
  // pi_session_trash makes 90: deleting a conversation now reaches pi's own
  // transcript, and that half is a separate command from the index-row delete
  // because the two fail differently. fs_index_files — the flat path list behind
  // `@`-mention completion — makes 91; it is separate from fs_list_dir because the
  // tree wants one directory's entries and completion wants the whole project's
  // paths, ignore rules applied.
  assert.equal(result.inventory.commandUniqueCount, 91);
});

test("locks the desktop command names and Pi process event names", () => {
  const result = inventory();
  assert.deepEqual(result.inventory.piEvents, ["pi://exit", "pi://line", "pi://stderr"]);
  assert.deepEqual(result.inventory.commandNames, [
    // routes the quit through Rust so backend teardown runs off the event-loop
    // thread instead of the WebView calling plugin-process exit() directly
    "app_quit",
    "chat_session_delete",
    "chat_session_load",
    "chat_session_rename",
    "chat_session_save",
    "chat_sessions_list",
    "fs_create_dir",
    "fs_create_file",
    "fs_delete",
    "fs_index_files",
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
    // opens an agent-written .html file as a file:// URL in the system browser
    "open_html_preview",
    "pet_window_hide",
    // invoked since the pet feature landed; the list simply never caught up,
    // and this suite could not run to say so
    "pet_window_prewarm",
    "pet_window_set_position",
    "pet_window_show",
    "pet_window_toggle",
    "pi_cli",
    "pi_cli_update_check",
    "pi_fetch_models",
    "pi_generate_title",
    "pi_send",
    "pi_session_trash",
    "pi_settings_read",
    "pi_settings_write",
    "pi_start",
    "pi_stop",
    "project_open",
    // a project opened on an SSH host: recorded in recents, but nothing local moves
    "project_open_remote",
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
    // Brings a host's launcher up to this build when that is safe, so a mode the
    // host predates is fixed before it is used rather than failing at the point of use
    "remote_launcher_autoupgrade",
    // Remote Agent (SSH execution): profile CRUD, launcher install, preflight,
    // capability discovery, and ~/.ssh/config alias reading
    "remote_profile_capabilities",
    "remote_profile_check_draft",
    "remote_profile_delete",
    "remote_profile_install_launcher",
    "remote_profile_preflight",
    "remote_profile_save",
    "remote_profiles_list",
    // provider sync — identifiers in, redacted previews out; provider JSON and
    // credentials never cross the port
    "remote_provider_sync_apply",
    "remote_provider_sync_candidates",
    "remote_provider_sync_prepare",
    // mints or reattaches a detached remote task; two SSH round trips, so it is
    // deliberately not part of the synchronous pi_start
    "remote_task_ensure",
    // asking the host what a task is doing — the only way out of `lost`, since a
    // partitioned pi outlives the desktop's knowledge by up to ~2h
    "remote_task_reap",
    "remote_task_status",
    // stops the work, as opposed to pi_stop which only closes the local channel
    "remote_task_stop",
    // raw interactive SSH PTY transport, intentionally separate from Pi's JSONL RPC
    "remote_terminal_resize",
    "remote_terminal_start",
    "remote_terminal_stop",
    "remote_terminal_write",
    // read-only remote browsing: list a directory, read a file. Writes stay
    // refused until V2.4 adds the hash check
    "remote_workspace_request",
    "runtime_config_read",
    "runtime_config_write",
    // `npx skills …` — skill install/remove/update, allowlisted subcommands only
    "skills_cli",
    // native catalogue search: skills.sh sends no CORS headers, so the webview
    // is not allowed to read the response
    "skills_search",
    "ssh_config_hosts",
    "workspace_root",
    "wsl_list_distros",
    "wsl_runtime_validate",
    "wsl_shell_bridge_path",
  ]);
});
