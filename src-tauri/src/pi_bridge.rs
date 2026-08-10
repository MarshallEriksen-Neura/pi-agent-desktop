//! Bridge to the `pi` coding agent CLI (`pi --mode rpc`).
//!
//! Spawns the process with piped stdio, forwards stdout lines to the
//! frontend as `pi://line` events (strict JSONL — LF delimited), stderr as
//! `pi://stderr`, and process exit as `pi://exit`. Commands come back in
//! through `pi_send` and are written to the child's stdin.

use pi_backend_core::pi_process::{
    LaunchSpec, PiProcess, ProcessEvent, ProcessLimits, ProcessPhase, ProcessSnapshot,
};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(5);

pub struct PiProc(pub Mutex<PiRuntime>);

pub struct PiRuntime {
    next_generation: u64,
    process: Option<Arc<PiProcess>>,
}

impl Default for PiProc {
    fn default() -> Self {
        Self(Mutex::new(PiRuntime {
            next_generation: 1,
            process: None,
        }))
    }
}

impl PiProc {
    pub fn shutdown(&self, timeout: Duration) -> Result<(), String> {
        let process = self
            .0
            .lock()
            .map_err(|_| "Pi runtime lock is poisoned".to_owned())?
            .process
            .clone();
        if let Some(process) = process {
            process.stop(timeout).map_err(|error| error.to_string())?;
            self.clear_if_current(&process)?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Option<ProcessSnapshot> {
        let process = self.0.lock().ok()?.process.clone()?;
        process.snapshot().ok()
    }

    fn clear_if_current(&self, observed: &Arc<PiProcess>) -> Result<(), String> {
        let mut runtime = self
            .0
            .lock()
            .map_err(|_| "Pi runtime lock is poisoned".to_owned())?;
        if runtime
            .process
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, observed))
        {
            runtime.process = None;
        }
        Ok(())
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
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| "Pi runtime lock is poisoned".to_owned())?;
    if let Some(process) = runtime.process.as_ref() {
        let snapshot = process.snapshot().map_err(|error| error.to_string())?;
        if matches!(
            snapshot.phase,
            ProcessPhase::Running | ProcessPhase::Stopping
        ) {
            return Ok(());
        }
        runtime.process.take();
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
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let generation = runtime.next_generation;
    runtime.next_generation = runtime.next_generation.saturating_add(1);
    let spec = LaunchSpec::from_command(&cmd);
    let process =
        PiProcess::spawn(
            generation,
            &spec,
            ProcessLimits::default(),
            move |event| match event {
                ProcessEvent::Stdout(line) => {
                    let _ = app.emit("pi://line", line);
                }
                ProcessEvent::Stderr(line) => {
                    let _ = app.emit("pi://stderr", line);
                }
                ProcessEvent::Exit(exit) => {
                    let _ = app.emit("pi://exit", exit.code);
                }
                ProcessEvent::Diagnostic(diagnostic) => {
                    eprintln!("[pi-process] {}", diagnostic.code);
                }
            },
        )
        .map_err(|error| format!("failed to spawn Pi CLI `{bin}`: {error}"))?;
    runtime.process = Some(Arc::new(process));
    Ok(())
}

#[tauri::command]
pub fn pi_send(state: State<'_, PiProc>, line: String) -> Result<(), String> {
    let process = state
        .0
        .lock()
        .map_err(|_| "Pi runtime lock is poisoned".to_owned())?
        .process
        .clone()
        .ok_or("pi is not running")?;
    process
        .send_json_line(&line)
        .map_err(|error| format!("write to pi failed: {error}"))
}

#[tauri::command]
pub fn pi_stop(state: State<'_, PiProc>) -> Result<(), String> {
    let process = state
        .0
        .lock()
        .map_err(|_| "Pi runtime lock is poisoned".to_owned())?
        .process
        .clone();
    if let Some(process) = process {
        process
            .stop(PROCESS_STOP_TIMEOUT)
            .map_err(|error| error.to_string())?;
        state.clear_if_current(&process)?;
    }
    Ok(())
}

const TITLE_TIMEOUT: Duration = Duration::from_secs(30);
const TITLE_RESPONSE_MAX_BYTES: usize = 8 * 1024;
const TITLE_PROMPT_PREFIX: &str = "Generate a concise, descriptive title for this coding conversation. Return only the title, with no quotes, markdown, explanation, or punctuation after it. Use the language of the user's message. Limit to 8 words or 48 characters.\n\nUser message:\n";
static TITLE_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct TitleGenerationGuard;

impl TitleGenerationGuard {
    fn acquire() -> Option<Self> {
        TITLE_IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

impl Drop for TitleGenerationGuard {
    fn drop(&mut self) {
        TITLE_IN_FLIGHT.store(false, Ordering::Release);
    }
}

struct EphemeralPiChild(Child);

impl Drop for EphemeralPiChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Run a separate, ephemeral Pi process for title generation.
///
/// This never talks to the primary process: it has no tools, no extensions,
/// and no session persistence, so its prompt cannot become part of the user's
/// conversation or trigger installed extension side effects.
#[tauri::command]
pub async fn pi_generate_title(
    prompt: String,
    provider: Option<String>,
    model_id: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let Some(_guard) = TitleGenerationGuard::acquire() else {
        return Ok(String::new());
    };
    tauri::async_runtime::spawn_blocking(move || {
        generate_title_blocking(prompt, provider, model_id, cwd)
    })
    .await
    .map_err(|error| format!("title generation task failed: {error}"))?
}

fn generate_title_blocking(
    prompt: String,
    provider: Option<String>,
    model_id: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Ok(String::new());
    }

    // A title needs only the first user turn. Bounding the request also avoids
    // duplicating a large paste or attachment transcription into another call.
    let user_message: String = prompt.chars().take(12_000).collect();
    let mut command = crate::pi_command::command(None)?;
    command.args([
        "--mode",
        "rpc",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--thinking",
        "off",
    ]);
    if let Some(provider) = provider.filter(|value| !value.trim().is_empty()) {
        command.args(["--provider", provider.trim()]);
    }
    if let Some(model_id) = model_id.filter(|value| !value.trim().is_empty()) {
        command.args(["--model", model_id.trim()]);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        command.current_dir(cwd);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = EphemeralPiChild(
        command
            .spawn()
            .map_err(|error| format!("failed to spawn title Pi process: {error}"))?,
    );
    let mut stdin = child.0.stdin.take().ok_or("title Pi has no stdin")?;
    let stdout = child.0.stdout.take().ok_or("title Pi has no stdout")?;
    let title_request = serde_json::json!({
        "type": "prompt",
        "message": format!("{TITLE_PROMPT_PREFIX}{user_message}"),
    });
    writeln!(stdin, "{title_request}")
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("failed to send title prompt: {error}"))?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + TITLE_TIMEOUT;
    let mut response = String::new();
    let mut completed = false;
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(line) => {
                let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                match event.get("type").and_then(serde_json::Value::as_str) {
                    Some("message_update") => {
                        if event
                            .pointer("/assistantMessageEvent/type")
                            .and_then(serde_json::Value::as_str)
                            != Some("text_delta")
                        {
                            continue;
                        }
                        let delta = event
                            .pointer("/assistantMessageEvent/delta")
                            .and_then(serde_json::Value::as_str);
                        if let Some(delta) = delta {
                            if response.len().saturating_add(delta.len()) > TITLE_RESPONSE_MAX_BYTES
                            {
                                return Err("title response exceeded its size limit".into());
                            }
                            response.push_str(delta);
                        }
                    }
                    Some("response")
                        if event.get("command").and_then(serde_json::Value::as_str)
                            == Some("prompt")
                            && event.get("success").and_then(serde_json::Value::as_bool)
                                == Some(false) =>
                    {
                        return Err("title prompt was rejected by Pi".into());
                    }
                    Some("agent_end") => {
                        completed = true;
                        break;
                    }
                    _ => {}
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if !completed {
        return Err("title generation timed out or the Pi process exited early".into());
    }
    Ok(normalize_title(&response))
}

fn normalize_title(raw: &str) -> String {
    let title = raw
        .lines()
        .find_map(|line| {
            let line = line.trim().trim_matches(['\"', '\'', '`']);
            (!line.is_empty()).then_some(line)
        })
        .unwrap_or("");
    let title = title
        .strip_prefix("Title:")
        .or_else(|| title.strip_prefix("title:"))
        .unwrap_or(title)
        .trim();
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

#[cfg(test)]
mod title_tests {
    use super::normalize_title;

    #[test]
    fn normalizes_model_title_output() {
        assert_eq!(
            normalize_title("\n\"Refactor session persistence\"\n"),
            "Refactor session persistence"
        );
        assert_eq!(
            normalize_title("Title: Improve model picker\nExplanation"),
            "Improve model picker"
        );
    }
}
