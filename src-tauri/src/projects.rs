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
    Ok(crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("desktop.json"))
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// Unix epoch milliseconds — sortable without a datetime dependency.
    pub last_opened_at: u64,
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
    /// Where Pi's bash commands run (Windows vs WSL). App-owned metadata.
    runtime: crate::wsl::RuntimeConfig,
    /// Original project-level shell overrides, keyed by normalized project root.
    project_shell_backups: BTreeMap<String, ShellSettingsBackup>,
}

/// Read the persisted command-runtime config. The shell bridge reads this for
/// every command so distro switches never depend on process-global state.
pub fn runtime_config() -> Result<crate::wsl::RuntimeConfig, String> {
    Ok(read_state()?.runtime)
}

#[tauri::command]
pub fn runtime_config_read() -> Result<crate::wsl::RuntimeConfig, String> {
    runtime_config()
}

#[tauri::command]
pub fn runtime_config_write(config: crate::wsl::RuntimeConfig) -> Result<(), String> {
    update_state(|state| state.runtime = config)
}

/// Canonical key for a project root — forward slashes, no trailing slash. Used
/// wherever app-owned state is filed per project (shell backups, chat sessions).
pub fn project_key(root: &str) -> String {
    root.replace('\\', "/").trim_end_matches('/').to_string()
}

pub fn project_shell_backup(root: &str) -> Result<Option<ShellSettingsBackup>, String> {
    Ok(read_state()?
        .project_shell_backups
        .get(&project_key(root))
        .cloned())
}

pub fn project_shell_backup_write(root: &str, backup: ShellSettingsBackup) -> Result<(), String> {
    update_state(|state| {
        state
            .project_shell_backups
            .insert(project_key(root), backup);
    })
}

pub fn project_shell_backup_remove(root: &str) -> Result<(), String> {
    update_state(|state| {
        state.project_shell_backups.remove(&project_key(root));
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
    // Verbatim UNC (`\\?\UNC\server\share`) → `//server/share` so WSL project
    // roots come back as `//wsl.localhost/<distro>/…` the frontend can read.
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

/// Recent projects whose directories still exist, most recent first.
#[tauri::command]
pub fn projects_recent() -> Result<Vec<RecentProject>, String> {
    Ok(read_state()?
        .recent_projects
        .into_iter()
        .filter(|r| Path::new(&r.path).is_dir())
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
    crate::wsl::validate_project_path(&runtime_config()?, &root)?;
    Ok(root)
}

/// Persist a project only after the frontend has activated its Pi/session
/// runtime. Revalidation closes the gap between resolve and commit.
#[tauri::command]
pub fn project_open(path: String) -> Result<String, String> {
    let root = project_resolve(path)?;
    let canon = PathBuf::from(&root);
    let name = canon
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.clone());

    update_state(|state| {
        state.last_project = Some(root.clone());
        state.recent_projects.retain(|recent| recent.path != root);
        state.recent_projects.insert(
            0,
            RecentProject {
                path: root.clone(),
                name,
                last_opened_at: now_ms(),
            },
        );
        state.recent_projects.truncate(MAX_RECENTS);
    })?;
    Ok(root)
}

/// Drop one entry from the recents list (the current project is untouched).
#[tauri::command]
pub fn project_remove_recent(path: String) -> Result<Vec<RecentProject>, String> {
    update_state(|state| state.recent_projects.retain(|recent| recent.path != path))?;
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
