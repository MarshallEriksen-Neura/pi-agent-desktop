//! Interactive SSH terminals backed by a local PTY.
//!
//! The existing Pi SSH bridge is a JSONL RPC channel and must remain line based.
//! This module gives OpenSSH its own PTY so terminal bytes, signals and window
//! changes never share or corrupt that protocol.

use crate::remote_profiles::{self, ExecutionBinding};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const MAX_SESSION_ID_BYTES: usize = 96;
const MAX_WRITE_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_COLS: u16 = 1_000;
const MAX_TERMINAL_ROWS: u16 = 1_000;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalDataEvent {
    session_id: String,
    generation: u64,
    data_base64: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteTerminalExitEvent {
    session_id: String,
    generation: u64,
    code: Option<u32>,
    signal: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTerminalStartResult {
    session_id: String,
    target_id: String,
}

struct ManagedTerminal {
    generation: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    stopping: bool,
}

#[derive(Clone, Default)]
pub struct RemoteTerminalState {
    sessions: Arc<Mutex<HashMap<String, ManagedTerminal>>>,
}

impl RemoteTerminalState {
    pub fn shutdown(&self) {
        let sessions = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>(),
            Err(_) => return,
        };
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("remote terminal session id is invalid".into());
    }
    Ok(())
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 || cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS {
        return Err("remote terminal size is invalid".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[tauri::command]
pub fn remote_terminal_start(
    app: AppHandle,
    state: State<'_, RemoteTerminalState>,
    session_id: String,
    generation: u64,
    execution_binding: ExecutionBinding,
    cols: u16,
    rows: u16,
) -> Result<RemoteTerminalStartResult, String> {
    validate_session_id(&session_id)?;
    if generation == 0 {
        return Err("remote terminal generation is invalid".into());
    }
    let size = terminal_size(cols, rows)?;
    let ExecutionBinding::Ssh { profile_id, .. } = &execution_binding else {
        return Err("remote terminal requires an SSH execution binding".into());
    };
    let profile = remote_profiles::load_profile(profile_id)?;
    let spec = remote_profiles::ssh_terminal_spec(&profile, &execution_binding)?;

    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "remote terminal state lock is poisoned".to_owned())?;
        if sessions.contains_key(&session_id) {
            return Err("remote terminal session is already running".into());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("cannot create terminal: {error}"))?;
    let mut command = CommandBuilder::new(&spec.program);
    command.args(&spec.args);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("cannot start SSH terminal: {error}"))?;
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("cannot read SSH terminal: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("cannot write SSH terminal: {error}"));
        }
    };
    let killer = child.clone_killer();

    {
        let mut sessions = match state.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("remote terminal state lock is poisoned".into());
            }
        };
        if sessions.contains_key(&session_id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("remote terminal session is already running".into());
        }
        sessions.insert(
            session_id.clone(),
            ManagedTerminal {
                generation,
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                stopping: false,
            },
        );
    }

    let reader_app = app.clone();
    let reader_session_id = session_id.clone();
    let reader_generation = generation;
    let reader_thread = match std::thread::Builder::new()
        .name(format!("remote-terminal-read-{session_id}"))
        .spawn(move || {
            let mut buffer = vec![0_u8; OUTPUT_CHUNK_BYTES];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        let _ = reader_app.emit_to(
                            "main",
                            "remote-terminal://data",
                            RemoteTerminalDataEvent {
                                session_id: reader_session_id.clone(),
                                generation: reader_generation,
                                data_base64: STANDARD.encode(&buffer[..count]),
                            },
                        );
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        }) {
        Ok(thread) => thread,
        Err(error) => {
            if let Ok(mut sessions) = state.sessions.lock() {
                if sessions
                    .get(&session_id)
                    .is_some_and(|session| session.generation == generation)
                {
                    sessions.remove(&session_id);
                }
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("cannot start terminal reader: {error}"));
        }
    };

    let wait_app = app;
    let wait_session_id = session_id.clone();
    let sessions = state.sessions.clone();
    let wait_child = Arc::new(Mutex::new(child));
    let cleanup_child = Arc::clone(&wait_child);
    let wait_reader = Arc::new(Mutex::new(Some(reader_thread)));
    let cleanup_reader = Arc::clone(&wait_reader);
    let wait_thread = std::thread::Builder::new()
        .name(format!("remote-terminal-wait-{session_id}"))
        .spawn(move || {
            let (code, signal, error) = match wait_child.lock() {
                Ok(mut child) => match child.wait() {
                    Ok(status) => (
                        Some(status.exit_code()),
                        status.signal().map(str::to_owned),
                        None,
                    ),
                    Err(error) => (None, None, Some(error.to_string())),
                },
                Err(_) => (
                    None,
                    None,
                    Some("remote terminal child lock is poisoned".to_owned()),
                ),
            };
            // Removing the session closes the PTY master and input writer. The
            // reader can then drain any buffered output before exit is emitted.
            if let Ok(mut sessions) = sessions.lock() {
                if sessions
                    .get(&wait_session_id)
                    .is_some_and(|session| session.generation == generation)
                {
                    sessions.remove(&wait_session_id);
                }
            }
            if let Ok(mut reader) = wait_reader.lock() {
                if let Some(reader) = reader.take() {
                    let _ = reader.join();
                }
            }
            let _ = wait_app.emit_to(
                "main",
                "remote-terminal://exit",
                RemoteTerminalExitEvent {
                    session_id: wait_session_id,
                    generation,
                    code,
                    signal,
                    error,
                },
            );
        });
    if let Err(error) = wait_thread {
        if let Ok(mut sessions) = state.sessions.lock() {
            if sessions
                .get(&session_id)
                .is_some_and(|session| session.generation == generation)
            {
                sessions.remove(&session_id);
            }
        }
        if let Ok(mut child) = cleanup_child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut reader) = cleanup_reader.lock() {
            if let Some(reader) = reader.take() {
                let _ = reader.join();
            }
        }
        return Err(format!("cannot start terminal waiter: {error}"));
    }

    Ok(RemoteTerminalStartResult {
        session_id,
        target_id: format!("ssh:{profile_id}"),
    })
}

#[tauri::command]
pub async fn remote_terminal_write(
    state: State<'_, RemoteTerminalState>,
    session_id: String,
    generation: u64,
    data: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    if data.len() > MAX_WRITE_BYTES {
        return Err("remote terminal input is too large".into());
    }
    let writer = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "remote terminal state lock is poisoned".to_owned())?;
        let session = sessions
            .get(&session_id)
            .ok_or("remote terminal session is not running")?;
        if session.generation != generation {
            return Err("remote terminal generation does not match".into());
        }
        if session.stopping {
            return Err("remote terminal session is stopping".into());
        }
        Arc::clone(&session.writer)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = writer
            .lock()
            .map_err(|_| "remote terminal writer lock is poisoned".to_owned())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("cannot write SSH terminal: {error}"))
    })
    .await
    .map_err(|error| format!("remote terminal writer task failed: {error}"))?
}

#[tauri::command]
pub fn remote_terminal_resize(
    state: State<'_, RemoteTerminalState>,
    session_id: String,
    generation: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let size = terminal_size(cols, rows)?;
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "remote terminal state lock is poisoned".to_owned())?;
    let session = sessions
        .get(&session_id)
        .ok_or("remote terminal session is not running")?;
    if session.generation != generation {
        return Err("remote terminal generation does not match".into());
    }
    if session.stopping {
        return Err("remote terminal session is stopping".into());
    }
    session
        .master
        .resize(size)
        .map_err(|error| format!("cannot resize SSH terminal: {error}"))
}

#[tauri::command]
pub fn remote_terminal_stop(
    state: State<'_, RemoteTerminalState>,
    session_id: String,
    generation: u64,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "remote terminal state lock is poisoned".to_owned())?;
    if let Some(session) = sessions.get_mut(&session_id) {
        if session.generation != generation {
            return Err("remote terminal generation does not match".into());
        }
        if session.stopping {
            return Ok(());
        }
        session.stopping = true;
        if let Err(error) = session.killer.kill() {
            session.stopping = false;
            return Err(format!("cannot stop SSH terminal: {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_and_sizes_are_bounded() {
        assert!(validate_session_id("term_abc-123").is_ok());
        assert!(validate_session_id("bad/session").is_err());
        assert!(terminal_size(80, 24).is_ok());
        assert!(terminal_size(0, 24).is_err());
        assert!(terminal_size(80, 1001).is_err());
    }
}
