//! Interactive local and SSH terminals backed by independent native PTYs.
//!
//! Pi's JSONL RPC channel remains line based and completely separate. This module
//! owns raw terminal bytes, process lifecycle, signals, and window-size changes for
//! both local shells and OpenSSH clients.

use crate::remote_profiles::{self, ExecutionBinding};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

const MAX_SESSION_ID_BYTES: usize = 96;
const MAX_WRITE_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_COLS: u16 = 1_000;
const MAX_TERMINAL_ROWS: u16 = 1_000;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LocalTerminalShellProfile {
    Auto,
    Custom { executable: String },
}
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
    shell_fallback: bool,
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

fn kill_terminal(killer: &mut (dyn ChildKiller + Send + Sync)) -> Result<(), String> {
    let result = killer.kill();
    #[cfg(windows)]
    {
        // portable-pty 0.9.0 inverts TerminateProcess's success result on Windows.
        // Closing the retained PTY handles still provides deterministic cleanup.
        let _ = result;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        result.map_err(|error| format!("cannot stop terminal: {error}"))
    }
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > MAX_SESSION_ID_BYTES
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("terminal session id is invalid".into());
    }
    Ok(())
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols == 0 || rows == 0 || cols > MAX_TERMINAL_COLS || rows > MAX_TERMINAL_ROWS {
        return Err("terminal size is invalid".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn validated_local_cwd(cwd: Option<&str>) -> Result<Option<PathBuf>, String> {
    let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err("local terminal working directory must be absolute".into());
    }
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("cannot access local terminal working directory: {error}"))?;
    if !metadata.is_dir() {
        return Err("local terminal working directory is not a directory".into());
    }
    Ok(Some(path.to_path_buf()))
}

#[cfg(windows)]
fn automatic_windows_shell_candidates_from(
    program_files_roots: &[PathBuf],
    system_root: Option<PathBuf>,
    comspec: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("pwsh.exe")];
    for root in program_files_roots {
        let candidate = root.join("PowerShell").join("7").join("pwsh.exe");
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates.push(PathBuf::from("powershell.exe"));
    if let Some(system_root) = system_root {
        candidates.push(
            system_root
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
    }
    if let Some(comspec) = comspec {
        candidates.push(comspec);
    }
    candidates.push(PathBuf::from("cmd.exe"));
    candidates
}

#[cfg(windows)]
fn automatic_windows_shell_candidates() -> Vec<PathBuf> {
    let mut program_files_roots = Vec::new();
    for name in ["ProgramW6432", "ProgramFiles"] {
        if let Some(root) = std::env::var_os(name).map(PathBuf::from) {
            if root.is_absolute() && !program_files_roots.contains(&root) {
                program_files_roots.push(root);
            }
        }
    }
    automatic_windows_shell_candidates_from(
        &program_files_roots,
        std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute()),
        std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute()),
    )
}

#[cfg(windows)]
fn local_shell_command_builder(executable: PathBuf) -> CommandBuilder {
    let executable = std::fs::canonicalize(&executable).unwrap_or(executable);
    let keep_command_prompt_open = executable
        .file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cmd.exe"));
    let mut command = CommandBuilder::new(executable);
    if keep_command_prompt_open {
        command.arg("/K");
        command.arg("rem");
    }
    command
}

#[cfg(not(windows))]
fn local_shell_command_builder(executable: PathBuf) -> CommandBuilder {
    CommandBuilder::new(executable)
}

#[cfg(windows)]
fn automatic_local_shell_command() -> CommandBuilder {
    automatic_windows_shell_candidates()
        .into_iter()
        .find_map(|candidate| crate::pi_command::resolve_executable(&candidate.to_string_lossy()))
        .map(local_shell_command_builder)
        .unwrap_or_else(CommandBuilder::new_default_prog)
}

#[cfg(not(windows))]
fn automatic_local_shell_command() -> CommandBuilder {
    CommandBuilder::new_default_prog()
}

fn local_shell_command(profile: Option<&LocalTerminalShellProfile>) -> (CommandBuilder, bool) {
    let Some(LocalTerminalShellProfile::Custom { executable }) = profile else {
        return (automatic_local_shell_command(), false);
    };
    let executable = executable.trim();
    if executable.is_empty() || !Path::new(executable).is_absolute() {
        return (automatic_local_shell_command(), true);
    }
    match crate::pi_command::resolve_executable(executable) {
        Some(executable) => (local_shell_command_builder(executable), false),
        None => (automatic_local_shell_command(), true),
    }
}

fn configure_terminal_command(command: &mut CommandBuilder, cwd: Option<&Path>) {
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
}

#[tauri::command]
pub fn remote_terminal_start(
    app: AppHandle,
    state: State<'_, RemoteTerminalState>,
    session_id: String,
    generation: u64,
    execution_binding: ExecutionBinding,
    cwd: Option<String>,
    local_shell: Option<LocalTerminalShellProfile>,
    cols: u16,
    rows: u16,
) -> Result<RemoteTerminalStartResult, String> {
    validate_session_id(&session_id)?;
    if generation == 0 {
        return Err("terminal generation is invalid".into());
    }
    let size = terminal_size(cols, rows)?;
    let (mut command, target_id, mut shell_fallback, local_cwd, custom_shell_selected) =
        match &execution_binding {
            ExecutionBinding::Local { target_id } => {
                if target_id != "local" {
                    return Err("local terminal target is invalid".into());
                }
                let (command, shell_fallback) = local_shell_command(local_shell.as_ref());
                let local_cwd = validated_local_cwd(cwd.as_deref())?;
                let custom_shell_selected = matches!(
                    local_shell.as_ref(),
                    Some(LocalTerminalShellProfile::Custom { .. })
                ) && !shell_fallback;
                (
                    command,
                    target_id.clone(),
                    shell_fallback,
                    local_cwd,
                    custom_shell_selected,
                )
            }
            ExecutionBinding::Ssh { profile_id, .. } => {
                let profile = remote_profiles::load_profile(profile_id)?;
                let spec = remote_profiles::ssh_terminal_spec(&profile, &execution_binding)?;
                let mut command = CommandBuilder::new(&spec.program);
                command.args(&spec.args);
                (command, format!("ssh:{profile_id}"), false, None, false)
            }
        };
    configure_terminal_command(&mut command, local_cwd.as_deref());

    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal state lock is poisoned".to_owned())?;
        if sessions.contains_key(&session_id) {
            return Err("terminal session is already running".into());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|error| format!("cannot create terminal: {error}"))?;
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(custom_error) if custom_shell_selected => {
            let mut fallback = automatic_local_shell_command();
            configure_terminal_command(&mut fallback, local_cwd.as_deref());
            shell_fallback = true;
            pair.slave.spawn_command(fallback).map_err(|fallback_error| {
                format!(
                    "cannot start custom terminal shell ({custom_error}); automatic fallback also failed: {fallback_error}"
                )
            })?
        }
        Err(error) => return Err(format!("cannot start terminal: {error}")),
    };
    drop(pair.slave);

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("cannot read terminal: {error}"));
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("cannot write terminal: {error}"));
        }
    };
    let killer = child.clone_killer();

    {
        let mut sessions = match state.sessions.lock() {
            Ok(sessions) => sessions,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("terminal state lock is poisoned".into());
            }
        };
        if sessions.contains_key(&session_id) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("terminal session is already running".into());
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
        target_id,
        shell_fallback,
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
            .map_err(|error| format!("cannot write terminal: {error}"))
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
        .map_err(|error| format!("cannot resize terminal: {error}"))
}
fn stop_terminal_session(
    sessions: &mut HashMap<String, ManagedTerminal>,
    session_id: &str,
    generation: u64,
) -> Result<(), String> {
    let should_remove = match sessions.get_mut(session_id) {
        Some(session) => {
            if session.generation != generation {
                return Err("remote terminal generation does not match".into());
            }
            if session.stopping {
                return Ok(());
            }
            session.stopping = true;
            if let Err(error) = kill_terminal(session.killer.as_mut()) {
                session.stopping = false;
                return Err(error);
            }
            true
        }
        None => false,
    };
    if should_remove {
        sessions.remove(session_id);
    }
    Ok(())
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
    stop_terminal_session(&mut sessions, &session_id, generation)
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

    #[test]
    fn local_cwd_must_be_an_existing_absolute_directory() {
        assert_eq!(validated_local_cwd(None).unwrap(), None);
        assert_eq!(validated_local_cwd(Some("   ")).unwrap(), None);
        assert!(validated_local_cwd(Some("relative/path")).is_err());
        assert_eq!(
            validated_local_cwd(std::env::temp_dir().to_str()).unwrap(),
            Some(std::env::temp_dir())
        );
        let missing = std::env::temp_dir().join(format!(
            "ragcode-terminal-missing-directory-{}",
            std::process::id()
        ));
        assert!(validated_local_cwd(missing.to_str()).is_err());
    }

    #[test]
    fn custom_local_shell_requires_an_existing_absolute_executable() {
        let current_exe = std::env::current_exe().expect("test executable path should resolve");
        let expected = std::fs::canonicalize(&current_exe).expect("test executable should resolve");
        let profile = LocalTerminalShellProfile::Custom {
            executable: current_exe.to_string_lossy().into_owned(),
        };
        let (command, fell_back) = local_shell_command(Some(&profile));
        assert!(!fell_back);
        assert_eq!(command.get_argv().first(), Some(&expected.into_os_string()));

        let relative = LocalTerminalShellProfile::Custom {
            executable: "relative-shell".into(),
        };
        let (_, fell_back) = local_shell_command(Some(&relative));
        assert!(fell_back);

        let missing =
            std::env::temp_dir().join(format!("ragcode-missing-shell-{}", std::process::id()));
        let missing = LocalTerminalShellProfile::Custom {
            executable: missing.to_string_lossy().into_owned(),
        };
        let (_, fell_back) = local_shell_command(Some(&missing));
        assert!(fell_back);
    }

    #[cfg(windows)]
    #[test]
    fn command_prompt_shell_is_kept_open_for_interactive_use() {
        let executable = PathBuf::from(r"C:\Windows\System32\CMD.EXE");
        let expected = std::fs::canonicalize(&executable).expect("command prompt should resolve");
        let command = local_shell_command_builder(executable.clone());
        assert_eq!(
            command.get_argv(),
            &vec![
                expected.into_os_string(),
                std::ffi::OsString::from("/K"),
                std::ffi::OsString::from("rem"),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn command_prompt_shell_stays_alive_in_a_native_pty() {
        let executable = PathBuf::from("C:/Windows/System32/cmd.exe");
        assert!(executable.is_file(), "Windows command prompt should exist");
        let pty = native_pty_system()
            .openpty(terminal_size(80, 24).unwrap())
            .expect("native PTY should open");
        let mut child = pty
            .slave
            .spawn_command(local_shell_command_builder(executable))
            .expect("command prompt should start");
        drop(pty.slave);
        let mut writer = pty
            .master
            .take_writer()
            .expect("command prompt writer should open");

        std::thread::sleep(std::time::Duration::from_secs(2));
        assert!(
            child
                .try_wait()
                .expect("command prompt should be pollable")
                .is_none(),
            "command prompt should remain interactive without initial input"
        );
        writer
            .write_all(b"exit\r\n")
            .expect("command prompt should accept input");
        writer.flush().expect("command prompt input should flush");
        assert!(
            child.wait().expect("command prompt should exit").success(),
            "command prompt should exit successfully"
        );
    }
    #[cfg(not(windows))]
    #[test]
    fn automatic_unix_shell_keeps_portable_pty_system_default() {
        let (command, fell_back) = local_shell_command(Some(&LocalTerminalShellProfile::Auto));
        assert!(!fell_back);
        assert!(command.is_default_prog());
    }

    #[cfg(windows)]
    #[test]
    fn automatic_windows_shell_uses_the_documented_priority() {
        let candidates = automatic_windows_shell_candidates_from(
            &[
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"D:\Program Files"),
            ],
            Some(PathBuf::from(r"C:\Windows")),
            Some(PathBuf::from(r"C:\Windows\System32\cmd.exe")),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from("pwsh.exe"),
                PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
                PathBuf::from(r"D:\Program Files\PowerShell\7\pwsh.exe"),
                PathBuf::from("powershell.exe"),
                PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"),
                PathBuf::from(r"C:\Windows\System32\cmd.exe"),
                PathBuf::from("cmd.exe"),
            ]
        );

        let expected = automatic_windows_shell_candidates()
            .into_iter()
            .find_map(|candidate| {
                crate::pi_command::resolve_executable(&candidate.to_string_lossy())
            });
        let command = automatic_local_shell_command();
        if let Some(expected) = expected {
            let expected = std::fs::canonicalize(&expected).unwrap_or(expected);
            assert_eq!(command.get_argv().first(), Some(&expected.into_os_string()));
        } else {
            assert!(command.is_default_prog());
        }
    }
    #[test]
    fn successful_stop_releases_the_session_id_before_returning() {
        let pair = native_pty_system()
            .openpty(terminal_size(80, 24).unwrap())
            .expect("native PTY should open");
        let mut child = pair
            .slave
            .spawn_command(CommandBuilder::new_default_prog())
            .expect("default local shell should start");
        drop(pair.slave);
        let writer = pair
            .master
            .take_writer()
            .expect("local PTY writer should open");
        let killer = child.clone_killer();
        let mut sessions = HashMap::new();
        sessions.insert(
            "terminal-local".to_owned(),
            ManagedTerminal {
                generation: 1,
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
                stopping: false,
            },
        );

        stop_terminal_session(&mut sessions, "terminal-local", 1)
            .expect("local terminal should stop");

        assert!(!sessions.contains_key("terminal-local"));
        child.wait().expect("stopped local shell should be reaped");
    }

    #[test]
    fn default_local_shell_supports_io_resize_and_stop_in_a_native_pty() {
        let pty = native_pty_system()
            .openpty(terminal_size(80, 24).unwrap())
            .expect("native PTY should open");
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(std::env::temp_dir());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let mut reader = pty
            .master
            .try_clone_reader()
            .expect("local PTY reader should clone");
        let mut writer = pty
            .master
            .take_writer()
            .expect("local PTY writer should open");
        let mut child = pty
            .slave
            .spawn_command(command)
            .expect("default local shell should start");
        drop(pty.slave);

        let sentinel = format!("RAGCODE_LOCAL_PTY_{}", std::process::id());
        let expected = sentinel.as_bytes().to_vec();
        let (seen_tx, seen_rx) = std::sync::mpsc::channel();
        let reader_thread = std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(read) => {
                        output.extend_from_slice(&chunk[..read]);
                        if output
                            .windows(expected.len())
                            .any(|window| window == expected.as_slice())
                        {
                            let _ = seen_tx.send(());
                            return;
                        }
                    }
                }
            }
        });

        writer
            .write_all(format!("echo {sentinel}\r").as_bytes())
            .and_then(|_| writer.flush())
            .expect("local PTY should accept input");
        pty.master
            .resize(terminal_size(100, 32).unwrap())
            .expect("local PTY should resize");
        let saw_output = seen_rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .is_ok();

        child.kill().expect("default local shell should stop");
        child.wait().expect("stopped local shell should be reaped");
        drop(writer);
        drop(pty.master);
        reader_thread.join().expect("local PTY reader should join");
        assert!(saw_output, "default local shell should echo terminal input");
    }
}
