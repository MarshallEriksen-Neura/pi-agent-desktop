//! Bridge to the `pi` coding agent CLI (`pi --mode rpc`).
//!
//! Spawns the process with piped stdio, forwards stdout lines to the
//! frontend as `pi://line` events (strict JSONL — LF delimited), stderr as
//! `pi://stderr`, and process exit as `pi://exit`. Commands come back in
//! through `pi_send` and are written to the child's stdin.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

pub struct PiProc(pub Mutex<Option<PiHandle>>);

pub struct PiHandle {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

impl Default for PiProc {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
pub fn pi_start(
    app: AppHandle,
    state: State<'_, PiProc>,
    cwd: Option<String>,
    binary: Option<String>,
    resume_path: Option<String>,
) -> Result<(), String> {
    // Repair/migrate the WSL custom-shell override before the new Pi process
    // reads settings.json. Native mode is a no-op.
    crate::wsl::sync_shell_bridge_settings(cwd.as_deref())?;
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already running
    }

    let bin = binary.as_deref().unwrap_or("pi");
    let mut cmd = crate::pi_command::command(binary.as_deref())?;
    cmd.args(["--mode", "rpc"]);
    // Resume a specific session at process startup so pi loads the full prior
    // context (past turns, tool results, thinking) into its agent loop — the
    // post-start `switch_session` RPC is kept only as a best-effort fallback.
    // `--session <path|id>` is non-interactive (unlike `--resume`), which is
    // required for headless RPC mode.
    if let Some(path) = resume_path.as_deref() {
        let path = path.trim();
        if !path.is_empty() {
            cmd.args(["--session", path]);
        }
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    // no console flash on Windows
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn Pi CLI `{bin}`: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;

    // child is shared so the stdout waiter thread can read the real exit code
    let child = Arc::new(Mutex::new(child));

    // stdout reader → pi://line (one event per JSONL line)
    {
        let app = app.clone();
        let child = Arc::clone(&child);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app.emit("pi://line", line);
                }
            }
            // stdout closed → process exited; capture the exit code (if any)
            let code = child
                .lock()
                .ok()
                .and_then(|mut c| c.wait().ok())
                .and_then(|status| status.code());
            let _ = app.emit("pi://exit", code);
        });
    }

    // stderr reader → pi://stderr (diagnostics only)
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app.emit("pi://stderr", line);
            }
        });
    }

    *guard = Some(PiHandle { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn pi_send(state: State<'_, PiProc>, line: String) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let handle = guard.as_mut().ok_or("pi is not running")?;
    handle
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| handle.stdin.write_all(b"\n"))
        .and_then(|_| handle.stdin.flush())
        .map_err(|e| format!("write to pi failed: {e}"))
}

#[tauri::command]
pub fn pi_stop(state: State<'_, PiProc>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(handle) = guard.take() {
        let _ = handle.child.lock().ok().and_then(|mut c| c.kill().ok());
        let _ = handle.child.lock().ok().and_then(|mut c| c.wait().ok());
    }
    Ok(())
}
