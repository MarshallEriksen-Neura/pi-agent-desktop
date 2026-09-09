//! Where pi's own session files live, and the command that trashes one.
//!
//! The rules for *what* may be moved are in
//! [`pi_backend_core::session_files`] — they need real directories to be tested
//! against, and the `cdylib` test binary this crate builds cannot be executed.
//! What stays here is the part that is genuinely local to the desktop app: which
//! directories on this machine are the session root and the trash.

use pi_backend_core::session_discovery::{discover_sessions, NativeSessionMetadata};
use pi_backend_core::session_files::{
    purge_transcript, restore_transcript, trash_transcript, SessionTrashOutcome,
};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SESSION_READ_BYTES: u64 = 32 * 1024 * 1024;

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
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        crate::pi_settings::home_dir()?.join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    Ok(if expanded.is_absolute() {
        expanded
    } else {
        relative_to.join(expanded)
    })
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

fn default_session_dir_name(resolved_project_root: &Path) -> String {
    // `fs::canonicalize` returns verbatim paths (`\\?\C:\...` / `\\?\UNC\...`)
    // on Windows. Pi's Node CLI encodes the normal path shape, so normalize the
    // canonical path back to that shape before mirroring Pi's directory-name rule.
    let mut encoded = crate::projects::normalize(resolved_project_root);
    if encoded.starts_with('/') || encoded.starts_with('\\') {
        encoded.remove(0);
    }
    encoded = encoded.replace(['/', '\\', ':'], "-");
    format!("--{encoded}--")
}

fn default_session_root(project_root: &Path, agent: &Path) -> PathBuf {
    let resolved = fs::canonicalize(project_root).unwrap_or_else(|_| project_root.to_path_buf());
    agent
        .join("sessions")
        .join(default_session_dir_name(&resolved))
}

/// Resolve the effective local session root used by the Pi child process.
/// Pi CLI's explicit `--session-dir` wins before this function; the desktop
/// launcher does not currently supply that flag, so environment/settings are
/// the effective provider inputs here.
pub fn resolve_local_session_root(project_root: &Path) -> Result<(PathBuf, bool), String> {
    let project_root = if project_root.is_absolute() {
        project_root.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| error.to_string())?
            .join(project_root)
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

/// Read one local Pi transcript for instant history rendering.
///
/// `session_path` comes from SQLite, so it is treated as untrusted even though
/// the desktop wrote it there. Canonicalize both sides and require the transcript
/// to remain inside the effective session root before reading it.
#[tauri::command]
pub fn pi_session_read(path: String, project_root: String) -> Result<String, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("session path is empty".into());
    }
    let candidate = Path::new(raw);
    if candidate.extension().and_then(|value| value.to_str()) != Some("jsonl") {
        return Err("session path is not a .jsonl transcript".into());
    }

    let trusted_root = resolve_local_session_root(Path::new(&project_root))?.0;
    let trusted_root = trusted_root
        .canonicalize()
        .map_err(|error| format!("cannot resolve local session root: {error}"))?;
    let candidate = candidate
        .canonicalize()
        .map_err(|error| format!("cannot resolve session transcript: {error}"))?;
    if !candidate.starts_with(&trusted_root) {
        return Err("session transcript is outside the local session root".into());
    }

    let metadata = fs::metadata(&candidate)
        .map_err(|error| format!("cannot stat session transcript: {error}"))?;
    if !metadata.is_file() {
        return Err("session transcript is not a file".into());
    }
    if metadata.len() > MAX_SESSION_READ_BYTES {
        return Err(format!(
            "session transcript is too large to render ({} MB)",
            metadata.len() / (1024 * 1024)
        ));
    }
    fs::read_to_string(&candidate)
        .map_err(|error| format!("cannot read session transcript: {error}"))
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

pub(crate) fn recycle_local_transcript(
    project_root: &str,
    path: &str,
) -> Result<SessionTrashOutcome, String> {
    let trusted_root = resolve_local_session_root(Path::new(project_root))?.0;
    trash_transcript(&trusted_root, &trash_root()?, path)
}

pub(crate) fn restore_local_transcript(
    project_root: &str,
    original_path: &str,
    trash_file: Option<&str>,
    trash_directory: Option<&str>,
) -> Result<(), String> {
    let trusted_root = resolve_local_session_root(Path::new(project_root))?.0;
    restore_transcript(
        &trusted_root,
        &trash_root()?,
        original_path,
        trash_file,
        trash_directory,
    )
}

pub(crate) fn purge_local_transcript(
    project_root: &str,
    original_path: &str,
    trash_file: Option<&str>,
    trash_directory: Option<&str>,
) -> Result<(), String> {
    let trusted_root = resolve_local_session_root(Path::new(project_root))?.0;
    purge_transcript(
        &trusted_root,
        &trash_root()?,
        original_path,
        trash_file,
        trash_directory,
    )
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
    match project_root.filter(|value| !value.trim().is_empty()) {
        Some(project_root) => recycle_local_transcript(&project_root, &path),
        None => trash_transcript(&sessions_root()?, &trash_root()?, &path),
    }
}

#[cfg(test)]
mod tests {
    use super::default_session_dir_name;
    use std::path::Path;

    #[cfg(windows)]
    #[test]
    fn default_session_dir_strips_windows_verbatim_disk_prefix() {
        assert_eq!(
            default_session_dir_name(Path::new(r"\\?\C:\Users\V\Documents\Pix")),
            "--C--Users-V-Documents-Pix--"
        );
    }

    #[cfg(windows)]
    #[test]
    fn default_session_dir_normalizes_windows_verbatim_unc_prefix() {
        assert_eq!(
            default_session_dir_name(Path::new(r"\\?\UNC\server\share\project")),
            "---server-share-project--"
        );
    }
}
