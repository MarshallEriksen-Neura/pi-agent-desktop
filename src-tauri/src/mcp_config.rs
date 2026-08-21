//! Read/write the MCP configuration files consumed by pi-mcp-adapter.
//!
//! The desktop client owns only the Pi override files.  The adapter still
//! resolves other standard MCP locations inside the pi process, so this
//! module reports those locations for an informational UI warning instead of
//! merging or rewriting them.

use crate::pi_settings::{home_dir, SettingsFile};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn mcp_path(scope: &str, root: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(home_dir()?.join(".pi").join("agent").join("mcp.json")),
        "project" => match root {
            Some(r) => Ok(PathBuf::from(r).join(".pi").join("mcp.json")),
            None => std::env::current_dir()
                .map(|d| d.join(".pi").join("mcp.json"))
                .map_err(|e| e.to_string()),
        },
        other => Err(format!("unknown MCP scope: {other}")),
    }
}

fn mcp_directory(scope: &str, root: Option<&str>) -> Result<PathBuf, String> {
    let path = mcp_path(scope, root)?;
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "MCP config path has no parent directory".to_owned())
}

#[tauri::command]
pub fn mcp_config_read(scope: String, root: Option<String>) -> Result<SettingsFile, String> {
    let path = mcp_path(&scope, root.as_deref())?;
    let exists = path.is_file();
    let content = if exists {
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    Ok(SettingsFile {
        path: path.to_string_lossy().replace('\\', "/"),
        exists,
        content,
    })
}

#[tauri::command]
pub fn mcp_config_write(
    scope: String,
    content: String,
    root: Option<String>,
) -> Result<(), String> {
    let parsed = serde_json::from_str::<Value>(&content)
        .map_err(|e| format!("refusing to write invalid MCP JSON: {e}"))?;
    if !parsed.is_object() {
        return Err("refusing to write MCP config that is not a JSON object".to_owned());
    }

    let _write_guard = WRITE_LOCK
        .lock()
        .map_err(|_| "MCP config write lock is poisoned".to_owned())?;
    let path = mcp_path(&scope, root.as_deref())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let parent = path
        .parent()
        .ok_or_else(|| "MCP config path has no parent directory".to_owned())?;
    let sequence = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".mcp-config-{}-{sequence}.tmp", std::process::id()));
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| format!("cannot create MCP config temp file: {e}"))?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|_| file.sync_all())
    {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot write MCP config temp file: {error}"));
    }
    drop(file);
    replace_file(&tmp, &path, sequence)
}

/// Open the Pi-owned MCP configuration directory in the host file manager.
/// The directory is derived from the scope and project root; callers cannot
/// pass an arbitrary filesystem path.
#[tauri::command]
pub fn mcp_config_open_dir(scope: String, root: Option<String>) -> Result<(), String> {
    let directory = mcp_directory(&scope, root.as_deref())?;
    fs::create_dir_all(&directory).map_err(|error| {
        format!("cannot create MCP config directory {}: {error}", directory.display())
    })?;

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe").arg(&directory).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&directory).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&directory).spawn();

    result
        .map(|_| ())
        .map_err(|error| format!("cannot open MCP config directory: {error}"))
}

fn replace_file(temp: &Path, target: &Path, sequence: u64) -> Result<(), String> {
    let backup = target.with_extension(format!("bak-{}-{sequence}", std::process::id()));
    let had_target = target.is_file();
    if had_target {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("cannot clear stale MCP config backup: {error}"))?;
        }
        fs::rename(target, &backup)
            .map_err(|error| format!("cannot stage existing MCP config: {error}"))?;
    }
    if let Err(error) = fs::rename(temp, target) {
        if had_target {
            let _ = fs::rename(&backup, target);
        }
        let _ = fs::remove_file(temp);
        return Err(format!("cannot commit MCP config: {error}"));
    }
    if had_target {
        // The new config is already committed. Backup cleanup is best-effort so
        // callers never roll their UI state back after a successful write.
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpAdapterStatus {
    pub installed: bool,
    pub other_config_paths: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpDiscoverySource {
    pub id: String,
    pub label: String,
    pub path: String,
    pub scope: String,
    pub format: String,
    pub supported: bool,
    pub content: String,
    pub reason: Option<String>,
}

fn add_discovery_source(
    sources: &mut Vec<McpDiscoverySource>,
    id: &str,
    label: &str,
    scope: &str,
    format: &str,
    path: PathBuf,
    supported: bool,
    reason: Option<&str>,
) -> Result<(), String> {
    if !path.is_file() {
        return Ok(());
    }
    let display_path = path.to_string_lossy().replace('\\', "/");
    let content = if supported {
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("cannot read MCP source {display_path}: {error}"))?;
        if format == "toml" { filter_codex_mcp_toml(&raw) } else { raw }
    } else {
        String::new()
    };
    sources.push(McpDiscoverySource {
        id: id.to_owned(),
        label: label.to_owned(),
        path: display_path,
        scope: scope.to_owned(),
        format: format.to_owned(),
        supported,
        content,
        reason: reason.map(str::to_owned),
    });
    Ok(())
}

fn filter_codex_mcp_toml(content: &str) -> String {
    let mut in_mcp = false;
    let mut filtered = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_mcp = trimmed == "[mcp_servers]" || trimmed.starts_with("[mcp_servers.");
        }
        if in_mcp {
            filtered.push_str(line);
            filtered.push('\n');
        }
    }
    filtered
}

#[tauri::command]
pub fn mcp_config_discover(root: Option<String>) -> Result<Vec<McpDiscoverySource>, String> {
    let home = home_dir()?;
    let mut sources = Vec::new();
    let global_json_sources = [
        (
            "standard-global",
            "Standard MCP",
            home.join(".config").join("mcp").join("mcp.json"),
        ),
        (
            "agents-global",
            "Agents",
            home.join(".agents").join("mcp.json"),
        ),
        (
            "agents-nested-global",
            "Agents (nested)",
            home.join(".agents").join("mcp").join("mcp.json"),
        ),
        ("cursor-global", "Cursor", home.join(".cursor").join("mcp.json")),
        ("claude-global", "Claude Code", home.join(".claude.json")),
        (
            "windsurf-global",
            "Windsurf",
            home.join(".codeium").join("windsurf").join("mcp_config.json"),
        ),
        (
            "opencode-global",
            "OpenCode",
            home.join(".config").join("opencode").join("opencode.json"),
        ),
    ];
    for (id, label, path) in global_json_sources {
        add_discovery_source(
            &mut sources,
            id,
            label,
            "global",
            "json",
            path,
            true,
            None,
        )?;
    }
    add_discovery_source(
        &mut sources,
        "codex-global",
        "Codex CLI",
        "global",
        "toml",
        home.join(".codex").join("config.toml"),
        true,
        None,
    )?;

    if let Some(root) = root {
        let project = PathBuf::from(root);
        let project_sources = [
            ("standard-project", "Project MCP", project.join(".mcp.json")),
            ("cursor-project", "Cursor (project)", project.join(".cursor").join("mcp.json")),
            ("vscode-project", "VS Code", project.join(".vscode").join("mcp.json")),
            ("opencode-project", "OpenCode (project)", project.join("opencode.json")),
        ];
        for (id, label, path) in project_sources {
            add_discovery_source(
                &mut sources,
                id,
                label,
                "project",
                "json",
                path,
                true,
                None,
            )?;
        }
    }
    Ok(sources)
}

fn package_source(value: &Value) -> Option<&str> {
    match value {
        Value::String(source) => Some(source.as_str()),
        Value::Object(object) => object.get("source").and_then(Value::as_str),
        _ => None,
    }
}

fn adapter_installed(settings: &str) -> bool {
    serde_json::from_str::<Value>(settings)
        .ok()
        .and_then(|value| value.get("packages").cloned())
        .and_then(|packages| packages.as_array().cloned())
        .map(|packages| {
            packages.iter().any(|entry| {
                package_source(entry)
                    .map(|source| source == "npm:pi-mcp-adapter" || source == "pi-mcp-adapter")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn existing_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| path.is_file())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect()
}

#[tauri::command]
pub fn mcp_adapter_check(root: Option<String>) -> Result<McpAdapterStatus, String> {
    let home = home_dir()?;
    let settings = home.join(".pi").join("agent").join("settings.json");
    let settings_content = fs::read_to_string(&settings).unwrap_or_default();

    let mut other_paths = vec![
        home.join(".config").join("mcp").join("mcp.json"),
        home.join(".agents").join("mcp.json"),
        home.join(".agents").join("mcp").join("mcp.json"),
    ];
    if let Some(project) = root {
        let project = Path::new(&project);
        other_paths.push(project.join(".mcp.json"));
    }

    Ok(McpAdapterStatus {
        installed: adapter_installed(&settings_content),
        other_config_paths: existing_paths(other_paths),
    })
}

/// True when `entry` is the loopback MCP endpoint the removed in-app browser
/// pane used to register for itself.
///
/// Deliberately narrow: the port was OS-assigned on fallback, so it cannot be
/// matched exactly, but requiring the `http` type plus a
/// `http://127.0.0.1:<port>/mcp` URL keeps a user-authored server that merely
/// happens to be named `browser` from being deleted.
fn is_retired_browser_entry(entry: &Value) -> bool {
    let Some(object) = entry.as_object() else { return false };
    if object.get("type").and_then(Value::as_str) != Some("http") {
        return false;
    }
    let Some(url) = object.get("url").and_then(Value::as_str) else { return false };
    let Some(port) = url
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/mcp"))
    else {
        return false;
    };
    !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())
}

/// Drop the retired `browser` server from the global pi MCP config.
///
/// The in-app browser pane wrote this entry into the user's real `mcp.json` on
/// every launch. Deleting the pane's code alone would strand it there pointing
/// at a port nothing binds again, and pi reads `mcp.json` once at startup with
/// no way to reload — so every later session would boot with a dead server.
///
/// Returns `true` when an entry was removed. Safe to call on every startup;
/// once the key is gone this is a pure read. Can be deleted once shipped
/// installs have all run it at least once.
pub fn deregister_retired_browser_server() -> Result<bool, String> {
    let scope = "global";
    let read = mcp_config_read(scope.to_owned(), None)?;
    if !read.exists || read.content.trim().is_empty() {
        return Ok(false);
    }
    let mut config: Value =
        serde_json::from_str(&read.content).map_err(|e| format!("invalid mcp.json: {e}"))?;
    let Some(servers) = config
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
    else {
        return Ok(false);
    };
    match servers.get("browser") {
        Some(entry) if is_retired_browser_entry(entry) => {}
        // Absent, or a user-authored server that merely shares the name.
        _ => return Ok(false),
    }
    servers.remove("browser");
    let serialized =
        serde_json::to_string_pretty(&config).map_err(|e| format!("cannot serialize mcp.json: {e}"))?;
    mcp_config_write(scope.to_owned(), serialized, None)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::{
        adapter_installed, filter_codex_mcp_toml, is_retired_browser_entry, mcp_directory,
    };
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn recognizes_string_and_object_package_entries() {
        assert!(adapter_installed(r#"{"packages":["npm:pi-mcp-adapter"]}"#));
        assert!(adapter_installed(
            r#"{"packages":[{"source":"npm:pi-mcp-adapter"}]}"#
        ));
    }

    #[test]
    fn ignores_unrelated_or_malformed_package_entries() {
        assert!(!adapter_installed(
            r#"{"packages":["npm:other-extension"]}"#
        ));
        assert!(!adapter_installed("not json"));
    }

    #[test]
    fn derives_config_directories_only_from_supported_scopes() {
        let project = mcp_directory("project", Some("C:/workspace"))
            .expect("project MCP directory should resolve");
        assert!(project.ends_with(Path::new(".pi")));
        assert!(mcp_directory("unknown", Some("C:/workspace")).is_err());
    }

    #[test]
    fn filters_codex_toml_to_mcp_sections() {
        let filtered = filter_codex_mcp_toml(
            "model = \"private-model\"\n[mcp_servers.docs]\ncommand = \"npx\"\n[projects]\nsecret = \"not imported\"\n",
        );
        assert!(filtered.contains("[mcp_servers.docs]"));
        assert!(!filtered.contains("private-model"));
        assert!(!filtered.contains("not imported"));
    }

    #[test]
    fn recognizes_the_retired_browser_endpoint() {
        // The stable default port and the OS-assigned fallback both qualify.
        assert!(is_retired_browser_entry(&json!({
            "type": "http",
            "url": "http://127.0.0.1:51999/mcp",
            "enabled": true
        })));
        assert!(is_retired_browser_entry(&json!({
            "type": "http",
            "url": "http://127.0.0.1:0/mcp"
        })));
    }

    #[test]
    fn preserves_a_user_server_that_merely_shares_the_name() {
        // Remote host, stdio transport, non-loopback, or a different path are
        // all somebody else's `browser` server — never delete these.
        assert!(!is_retired_browser_entry(&json!({
            "type": "http",
            "url": "https://browser.example.com/mcp"
        })));
        assert!(!is_retired_browser_entry(&json!({
            "command": "npx",
            "args": ["-y", "some-browser-mcp"]
        })));
        assert!(!is_retired_browser_entry(&json!({
            "type": "http",
            "url": "http://127.0.0.1:51999/sse"
        })));
        assert!(!is_retired_browser_entry(&json!({
            "type": "http",
            "url": "http://127.0.0.1:abc/mcp"
        })));
        assert!(!is_retired_browser_entry(&json!("not an object")));
    }
}
