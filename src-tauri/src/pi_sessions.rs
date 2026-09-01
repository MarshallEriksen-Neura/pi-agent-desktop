//! Where pi's own session files live, and the command that trashes one.
//!
//! The rules for *what* may be moved are in
//! [`pi_backend_core::session_files`] — they need real directories to be tested
//! against, and the `cdylib` test binary this crate builds cannot be executed.
//! What stays here is the part that is genuinely local to the desktop app: which
//! directories on this machine are the session root and the trash.

use std::path::PathBuf;

use pi_backend_core::session_files::{trash_transcript, SessionTrashOutcome};

fn agent_dir() -> Result<PathBuf, String> {
    Ok(crate::pi_settings::home_dir()?.join(".pi").join("agent"))
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
pub fn pi_session_trash(path: String) -> Result<SessionTrashOutcome, String> {
    trash_transcript(&sessions_root()?, &trash_root()?, &path)
}
