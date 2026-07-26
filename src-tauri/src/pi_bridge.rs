//! Bridge to the `pi` coding agent CLI (`pi --mode rpc`).
//!
//! Spawns the process with piped stdio, forwards stdout lines to the
//! frontend as `pi://line` events (strict JSONL — LF delimited), stderr as
//! `pi://stderr`, and process exit as `pi://exit`. Commands come back in
//! through `pi_send` and are written to the child's stdin.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct PiProc(pub Mutex<Option<PiHandle>>);

pub struct PiHandle {
    child: Child,
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
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(()); // already running
    }

    let bin = binary.unwrap_or_else(|| "pi".to_string());
    let mut cmd = Command::new(&bin);
    cmd.args(["--mode", "rpc"])
        .stdin(Stdio::piped())
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
        .map_err(|e| format!("failed to spawn `{bin}`: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;

    // stdout reader → pi://line (one event per JSONL line)
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app.emit("pi://line", line);
                }
            }
            let _ = app.emit("pi://exit", ());
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
    if let Some(mut handle) = guard.take() {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}
