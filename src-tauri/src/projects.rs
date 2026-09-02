//! Project selection & recent-projects persistence for the desktop app.
//!
//! State lives in `~/.pi/agent/desktop.json` — owned by the desktop app, never
//! read by the pi CLI. The last-opened project becomes the workspace root on
//! the next launch (see `fs_bridge::workspace_root`).

use pi_backend_core::projects::canonical_project_root;
use pi_backend_core::projects::DurableJsonStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_RECENTS: usize = 10;
static DESKTOP_STATE_IO: Mutex<()> = Mutex::new(());

fn desktop_json_path() -> Result<PathBuf, String> {
    #[cfg(any(test, feature = "remote-control-smoke"))]
    if let Some(path) = std::env::var_os("RAGCODE_DESKTOP_STATE_PATH") {
        return Ok(PathBuf::from(path));
    }
    Ok(crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("desktop.json"))
}

/// The machine a recent project lives on. `"local"` or `"ssh:<profileId>"`, matching
/// the pi-process target id exactly — a remote path is only unambiguous when paired
/// with the host it belongs to, and `/srv/app` can exist on several.
pub const LOCAL_TARGET_ID: &str = "local";

fn default_target_id() -> String {
    LOCAL_TARGET_ID.to_owned()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// Unix epoch milliseconds — sortable without a datetime dependency.
    pub last_opened_at: u64,
    /// Defaulted so entries written before remote projects existed stay readable and
    /// keep meaning what they meant: local.
    #[serde(default = "default_target_id")]
    pub target_id: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellSettingsBackup {
    pub shell_path: Option<serde_json::Value>,
    pub shell_command_prefix: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct DesktopState {
    last_project: Option<String>,
    recent_projects: Vec<RecentProject>,
    /// Legacy WSL shell-bridge state retained for one upgrade migration window.
    runtime: crate::wsl::RuntimeConfig,
    /// Original project shell overrides awaiting restoration by that migration.
    project_shell_backups: BTreeMap<String, ShellSettingsBackup>,
}

/// Read the persisted command-runtime config. The shell bridge reads this for
/// every command so distro switches never depend on process-global state.
pub fn runtime_config() -> Result<crate::wsl::RuntimeConfig, String> {
    Ok(read_state()?.runtime)
}

/// Canonical key for a project root — forward slashes, no trailing slash. Used
/// wherever app-owned state is filed per project (shell backups, chat sessions).
pub fn project_key(root: &str) -> String {
    root.replace('\\', "/").trim_end_matches('/').to_string()
}

pub fn legacy_project_shell_backups() -> Result<BTreeMap<String, ShellSettingsBackup>, String> {
    Ok(read_state()?.project_shell_backups)
}

/// Commit the legacy runtime cleanup only after every settings file was restored.
/// Keeping this state update last makes an interrupted migration retryable.
pub fn complete_legacy_wsl_migration(config: crate::wsl::RuntimeConfig) -> Result<(), String> {
    update_state(|state| {
        state.runtime = config;
        state.project_shell_backups.clear();
    })
}

fn read_state() -> Result<DesktopState, String> {
    let _guard = DESKTOP_STATE_IO
        .lock()
        .map_err(|_| "desktop state lock is poisoned".to_owned())?;
    read_state_unlocked()
}

fn update_state(update: impl FnOnce(&mut DesktopState)) -> Result<(), String> {
    let _guard = DESKTOP_STATE_IO
        .lock()
        .map_err(|_| "desktop state lock is poisoned".to_owned())?;
    DurableJsonStore::new(desktop_json_path()?)
        .update_locked(|current| {
            let mut state = current.unwrap_or_default();
            update(&mut state);
            Ok((state, ()))
        })
        .map_err(|error| format!("desktop state update failed: {error}"))
}

fn read_state_unlocked() -> Result<DesktopState, String> {
    DurableJsonStore::new(desktop_json_path()?)
        .load()
        .map(|state| state.unwrap_or_default())
        .map_err(|error| format!("desktop state unavailable: {error}"))
}

/// Forward slashes everywhere; strip the Windows `\\?\` verbatim prefix that
/// `fs::canonicalize` produces.
fn normalize(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    // Verbatim UNC (`\\?\UNC\server\share`) → `//server/share` so the
    // frontend receives the normal UNC shape.
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        return format!("//{rest}");
    }
    s.strip_prefix("//?/").map(str::to_string).unwrap_or(s)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Last opened project that still exists on disk — the preferred workspace root.
pub fn last_project() -> Result<Option<String>, String> {
    Ok(read_state()?.last_project.filter(|p| Path::new(p).is_dir()))
}

/// Recent projects, most recent first.
///
/// Local entries are filtered by whether the directory still exists. Remote ones are
/// **not**: checking a remote path costs an SSH round trip, and doing that per entry
/// while rendering a list would make opening a menu wait on the network — or, worse,
/// silently drop every remote entry when the host is simply asleep. A remote path that
/// has gone away is reported when it is opened.
#[tauri::command]
pub fn projects_recent() -> Result<Vec<RecentProject>, String> {
    Ok(read_state()?
        .recent_projects
        .into_iter()
        .filter(|r| r.target_id != LOCAL_TARGET_ID || Path::new(&r.path).is_dir())
        .collect())
}

/// Validate and canonicalize a prospective project without persisting it.
#[tauri::command]
pub fn project_resolve(path: String) -> Result<String, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let canon = canonical_project_root(dir).map_err(|error| error.to_string())?;
    let root = normalize(&canon);
    Ok(root)
}

/// Persist a project only after the frontend has activated its Pi/session
/// runtime. Revalidation closes the gap between resolve and commit.
#[tauri::command]
pub fn project_open(
    path: String,
    remote_control: tauri::State<'_, crate::remote_control::RemoteControlState>,
) -> Result<String, String> {
    let root = project_resolve(path)?;
    let canon = PathBuf::from(&root);
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());
    let previous = read_state()?;
    let previous_last_project = previous.last_project;
    let previous_recent_projects = previous.recent_projects;

    update_state(|state| {
        state.last_project = Some(root.clone());
        state
            .recent_projects
            .retain(|recent| recent.path != root || recent.target_id != LOCAL_TARGET_ID);
        state.recent_projects.insert(
            0,
            RecentProject {
                path: root.clone(),
                name,
                last_opened_at: now_ms(),
                target_id: default_target_id(),
            },
        );
        state.recent_projects.truncate(MAX_RECENTS);
    })?;
    if let Err(error) = remote_control.sync_selected_project(Path::new(&root)) {
        let rollback = update_state(|state| {
            state.last_project = previous_last_project;
            state.recent_projects = previous_recent_projects;
        });
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!(
                "{error}; desktop project rollback also failed: {rollback}"
            )),
        };
    }
    Ok(root)
}

/// `local` or `ssh:<profileId>`. Validated so a malformed id cannot become a key that
/// nothing will ever match again.
fn validate_target_id(target_id: &str) -> Result<(), String> {
    if target_id == LOCAL_TARGET_ID {
        return Ok(());
    }
    let profile_id = target_id
        .strip_prefix("ssh:")
        .filter(|id| !id.is_empty())
        .ok_or_else(|| format!("unsupported execution target `{target_id}`"))?;
    if !profile_id
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(format!("unsupported execution target `{target_id}`"));
    }
    Ok(())
}

/// Record a project opened on a remote host.
///
/// Separate from `project_open` because almost none of that applies: there is nothing
/// to canonicalize (the path is already absolute POSIX and belongs to another machine),
/// no local filesystem rule to check, and no phone gateway to sync — the LAN gateway
/// shares *this* desktop's project, and a directory on an SSH host is not it.
/// `last_project` is left alone for the same reason: it becomes the local workspace
/// root on next launch.
///
/// Existence is the caller's business, checked with the workspace port's `stat` before
/// this is called, so a failure lands on the open action rather than on a menu.
#[tauri::command]
pub fn project_open_remote(path: String, target_id: String) -> Result<Vec<RecentProject>, String> {
    validate_target_id(&target_id)?;
    if target_id == LOCAL_TARGET_ID {
        return Err("project_open_remote requires a remote execution target".into());
    }
    if path.trim() != path
        || !path.starts_with('/')
        || path.len() > 4096
        || path.chars().any(char::is_control)
    {
        return Err("remote project path must be an absolute POSIX path".into());
    }
    let name = path
        .trim_end_matches('/')
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or("/")
        .to_owned();
    update_state(|state| {
        state
            .recent_projects
            .retain(|recent| recent.path != path || recent.target_id != target_id);
        state.recent_projects.insert(
            0,
            RecentProject {
                path,
                name,
                last_opened_at: now_ms(),
                target_id,
            },
        );
        state.recent_projects.truncate(MAX_RECENTS);
    })?;
    projects_recent()
}

/// Drop one entry from the recents list (the current project is untouched).
///
/// `target_id` is part of the identity: the same path can exist on several machines,
/// and forgetting one must not forget the others.
#[tauri::command]
pub fn project_remove_recent(
    path: String,
    target_id: Option<String>,
) -> Result<Vec<RecentProject>, String> {
    let target_id = target_id.unwrap_or_else(default_target_id);
    validate_target_id(&target_id)?;
    update_state(|state| {
        state
            .recent_projects
            .retain(|recent| recent.path != path || recent.target_id != target_id);
    })?;
    projects_recent()
}

/// Native folder picker. `async` so the blocking dialog runs off the main
/// thread (blocking there would deadlock on macOS).
#[tauri::command]
pub async fn project_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(f) => {
            let p = f.into_path().map_err(|e| e.to_string())?;
            Ok(Some(normalize(&p)))
        }
        None => Ok(None),
    }
}
