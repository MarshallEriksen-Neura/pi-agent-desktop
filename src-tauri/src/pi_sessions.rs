//! Where pi's own session files live, and the command that trashes one.
//!
//! The rules for *what* may be moved are in
//! [`pi_backend_core::session_files`] — they need real directories to be tested
//! against, and the `cdylib` test binary this crate builds cannot be executed.
//! What stays here is the part that is genuinely local to the desktop app: which
//! directories on this machine are the session root and the trash.

use pi_backend_core::session_discovery::{discover_sessions, NativeSessionMetadata};
use pi_backend_core::session_files::{trash_transcript, SessionTrashOutcome};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn agent_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("PI_CODING_AGENT_DIR").filter(|value| !value.is_empty()) {
        let base = env::current_dir().map_err(|error| error.to_string())?;
        return expand_path(&value.to_string_lossy(), &base);
    }
    Ok(crate::pi_settings::home_dir()?.join(".pi").join("agent"))
}

fn expand_path(value: &str, relative_to: &Path) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("session directory is empty".into());
    }
    let expanded = if trimmed == "~" {
        crate::pi_settings::home_dir()?
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        crate::pi_settings::home_dir()?.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    Ok(if expanded.is_absolute() { expanded } else { relative_to.join(expanded) })
}

fn setting_session_dir(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    value
        .get("sessionDir")?
        .as_str()
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
}

fn default_session_root(project_root: &Path, agent: &Path) -> PathBuf {
    let resolved = fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    let mut encoded = resolved.to_string_lossy().into_owned();
    if encoded.starts_with('/') || encoded.starts_with('\\') {
        encoded.remove(0);
    }
    encoded = encoded.replace(['/', '\\', ':'], "-");
    agent.join("sessions").join(format!("--{encoded}--"))
}

/// Resolve the effective local session root used by the Pi child process.
/// Pi CLI's explicit `--session-dir` wins before this function; the desktop
/// launcher does not currently supply that flag, so environment/settings are
/// the effective provider inputs here.
pub fn resolve_local_session_root(project_root: &Path) -> Result<(PathBuf, bool), String> {
    let project_root = if project_root.is_absolute() {
        project_root.to_path_buf()
    } else {
        env::current_dir().map_err(|error| error.to_string())?.join(project_root)
    };
    let agent = agent_dir()?;
    let configured = env::var("PI_CODING_AGENT_SESSION_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| setting_session_dir(&project_root.join(".pi").join("settings.json")))
        .or_else(|| setting_session_dir(&agent.join("settings.json")));
    let default = default_session_root(&project_root, &agent);
    let Some(configured) = configured else {
        return Ok((default, false));
    };
    let root = expand_path(&configured, &project_root)?;
    Ok((root.clone(), root != default))
}

pub fn discover_local_sessions(project_root: &str) -> Result<Vec<NativeSessionMetadata>, String> {
    let project = PathBuf::from(project_root);
    let (root, custom) = resolve_local_session_root(&project)?;
    Ok(discover_sessions(&root, &project, custom))
}

/// The root every trashable transcript must resolve under.
///
/// Anything that does not is refused rather than moved — see `resolve_within` in
/// the core module for why a database-sourced path cannot be trusted.
fn sessions_root() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("sessions"))
}

/// Deleted transcripts land here instead of being unlinked.
fn trash_root() -> Result<PathBuf, String> {
    Ok(agent_dir()?.join("session-trash"))
}

/// Move one conversation's transcript into `~/.pi/agent/session-trash/`.
///
/// Separate from `chat_store::chat_session_delete` on purpose: the caller drops
/// the index row first and treats this as best-effort cleanup, because the two
/// halves fail differently. See the core module's header for the full argument.
#[tauri::command]
pub fn pi_session_trash(
    path: String,
    project_root: Option<String>,
) -> Result<SessionTrashOutcome, String> {
    let trusted_root = match project_root.filter(|value| !value.trim().is_empty()) {
        Some(project_root) => resolve_local_session_root(Path::new(&project_root))?.0,
        None => sessions_root()?,
    };
    trash_transcript(&trusted_root, &trash_root()?, &path)
}
