//! Provider login (OAuth subscriptions and API keys) driven through pi's own
//! auth flows.
//!
//! pi implements every flow and owns `auth.json`; RPC mode exposes no login
//! command and `/login` is TUI-only. So this module runs a Node sidecar
//! (`provider_auth_sidecar.mjs`, embedded at compile time) against the
//! installed `@earendil-works/pi-coding-agent` package and forwards pi's
//! `AuthInteraction` over stdio: sidecar stdout lines become
//! `provider-auth://event` Tauri events, and prompt answers are written back to
//! its stdin.
//!
//! A credential written here is picked up by an already-running `pi --mode rpc`
//! child without a restart: pi's `AuthStorage` compares the auth.json file
//! revision on every read and reloads when it changed. The model *list* is a
//! separate snapshot that only refreshes on demand, which is why the UI still
//! offers a restart after a successful login.

use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// The sidecar is embedded so it cannot drift from this file or go missing from
/// an installed bundle.
const SIDECAR_SOURCE: &str = include_str!("provider_auth_sidecar.mjs");

/// Tauri event channel for sidecar messages. Deliberately not `pi://…`: the
/// backend-boundary check locks that namespace to the three pi process events.
const EVENT_NAME: &str = "provider-auth://event";

/// One-shot subcommands (`list`, `logout`) are local work.
const ONESHOT_TIMEOUT: Duration = Duration::from_secs(45);
/// A login waits on a human in a browser.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SidecarEvent {
    /// Raw JSONL line from the sidecar; parsed by the frontend adapter.
    line: String,
}

/// Sidecar script materialized next to nothing else, removed on drop.
struct SidecarScript(PathBuf);

impl SidecarScript {
    fn write() -> Result<Self, String> {
        // A per-process unique name keeps concurrent app instances apart.
        let name = format!("pi-provider-auth-{}.mjs", std::process::id());
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, SIDECAR_SOURCE)
            .map_err(|error| format!("cannot write login helper to {}: {error}", path.display()))?;
        Ok(Self(path))
    }
}

impl Drop for SidecarScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Kills the child if it is still running when the handle goes away, so a
/// browser-pending login can never outlive the app or a cancel.
struct SidecarChild(Child);

impl Drop for SidecarChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Locate pi's `dist/index.js`.
///
/// The `pi` shim sits in the npm global bin directory with `node_modules`
/// alongside it, which covers the documented `npm install -g` layout without
/// spawning anything. `npm root -g` is the fallback for prefixes that do not
/// follow that shape.
fn pi_dist_path() -> Result<PathBuf, String> {
    const REL: [&str; 4] = ["@earendil-works", "pi-coding-agent", "dist", "index.js"];

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(shim) = crate::pi_command::resolve_executable("pi") {
        if let Some(dir) = shim.parent() {
            roots.push(dir.join("node_modules"));
        }
    }
    if let Ok(mut npm) = crate::pi_command::command(Some("npm")) {
        npm.args(["root", "-g"]);
        no_console_window(&mut npm);
        if let Ok(output) = npm.output() {
            if output.status.success() {
                let root = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                if !root.is_empty() {
                    roots.push(PathBuf::from(root));
                }
            }
        }
    }

    for root in roots {
        let candidate = REL.iter().fold(root, |path, part| path.join(part));
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("Could not find the pi package. Install it with `npm install -g @earendil-works/pi-coding-agent` and restart Pi.".into())
}

#[cfg(windows)]
fn no_console_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_console_window(_command: &mut Command) {}

/// Build the sidecar invocation. `node` is resolved the same way `pi` is, so an
/// npm-prefix-only install still works.
fn sidecar_command(script: &SidecarScript, args: &[&str]) -> Result<Command, String> {
    let dist = pi_dist_path()?;
    let mut command = crate::pi_command::command(Some("node"))?;
    crate::pi_command::prepend_npm_bin_to_path(&mut command);
    command.arg(&script.0);
    command.arg(dist);
    command.args(args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_console_window(&mut command);
    Ok(command)
}

/// Run a subcommand to completion and return its stdout lines.
///
/// Both callers (`list`, `logout`) are short and produce a single terminal
/// message, so buffering is bounded and blocking is acceptable.
fn run_oneshot(args: &[&str]) -> Result<Vec<String>, String> {
    let script = SidecarScript::write()?;
    let mut command = sidecar_command(&script, args)?;
    let mut child = SidecarChild(
        command
            .spawn()
            .map_err(|error| format!("failed to start the login helper: {error}"))?,
    );
    // The helper only reads stdin during a login; dropping it here signals EOF.
    drop(child.0.stdin.take());
    let stdout = child.0.stdout.take().ok_or("login helper has no stdout")?;
    let stderr = child.0.stderr.take().ok_or("login helper has no stderr")?;

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    // Drained on its own thread so a chatty helper cannot fill the pipe and
    // deadlock against our stdout reader.
    let diagnostics = std::thread::spawn(move || {
        BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
            .collect::<Vec<_>>()
            .join("\n")
    });

    let deadline = Instant::now() + ONESHOT_TIMEOUT;
    let mut lines = Vec::new();
    while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
        match receiver.recv_timeout(remaining) {
            Ok(line) => lines.push(line),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("the login helper timed out".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if lines.is_empty() {
        let detail = diagnostics.join().unwrap_or_default();
        let detail = detail.lines().last().unwrap_or("no output").to_owned();
        return Err(format!("the login helper produced no output: {detail}"));
    }
    Ok(lines)
}

/// Active login. Only one runs at a time — the UI drives a single dialog, and a
/// second concurrent flow would race for the same loopback callback port.
struct LoginSession {
    generation: u64,
    stdin: ChildStdin,
    /// Held so dropping the session kills a browser-pending login.
    _child: SidecarChild,
    /// Held so the temp script outlives the process using it.
    _script: SidecarScript,
}

#[derive(Default)]
pub struct ProviderAuthState(Mutex<Option<LoginSession>>);

impl ProviderAuthState {
    /// Terminate any active login (cancel, replacement, or app shutdown).
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.0.lock() {
            guard.take();
        }
    }
}

/// Provider inventory with the login methods each one supports.
#[tauri::command]
pub async fn provider_auth_list() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| run_oneshot(&["list"]))
        .await
        .map_err(|error| format!("login helper task failed: {error}"))?
}

/// Clear a stored credential.
#[tauri::command]
pub async fn provider_auth_logout(provider_id: String) -> Result<Vec<String>, String> {
    let provider = provider_id.trim().to_owned();
    if provider.is_empty() {
        return Err("providerId is required".into());
    }
    tauri::async_runtime::spawn_blocking(move || run_oneshot(&["logout", &provider]))
        .await
        .map_err(|error| format!("login helper task failed: {error}"))?
}

/// Start a login. Returns as soon as the helper is spawned; every subsequent
/// message arrives as a `provider-auth://event`.
#[tauri::command]
pub fn provider_auth_begin(
    app: AppHandle,
    state: State<'_, ProviderAuthState>,
    provider_id: String,
    method: String,
) -> Result<(), String> {
    let provider = provider_id.trim().to_owned();
    if provider.is_empty() {
        return Err("providerId is required".into());
    }
    if method != "oauth" && method != "api_key" {
        return Err(format!("unknown login method: {method}"));
    }

    let script = SidecarScript::write()?;
    let mut command = sidecar_command(&script, &["login", &provider, &method])?;
    let mut child = SidecarChild(
        command
            .spawn()
            .map_err(|error| format!("failed to start the login helper: {error}"))?,
    );
    let stdin = child.0.stdin.take().ok_or("login helper has no stdin")?;
    let stdout = child.0.stdout.take().ok_or("login helper has no stdout")?;
    let stderr = child.0.stderr.take().ok_or("login helper has no stderr")?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "provider auth lock is poisoned".to_owned())?;
    // Replacing an in-flight login drops the old session, which kills it.
    let generation = guard.as_ref().map_or(1, |session| session.generation + 1);

    let forward = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let _ = forward.emit(EVENT_NAME, SidecarEvent { line });
        }
    });
    // Node warnings and stack traces would otherwise fill the pipe and stall
    // the flow; they are diagnostics only, so they go to the app log.
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[provider-auth] {line}");
        }
    });

    // Bound the flow so an abandoned browser tab cannot leak a live callback
    // server. Only cancels if this same login is still the active one.
    let watchdog = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(LOGIN_TIMEOUT);
        let state = watchdog.state::<ProviderAuthState>();
        let Ok(mut guard) = state.0.lock() else {
            return;
        };
        if guard
            .as_ref()
            .is_some_and(|session| session.generation == generation)
        {
            guard.take();
            let _ = watchdog.emit(
                EVENT_NAME,
                SidecarEvent {
                    line: r#"{"kind":"error","message":"login-timeout"}"#.to_owned(),
                },
            );
        }
    });

    *guard = Some(LoginSession {
        generation,
        stdin,
        _child: child,
        _script: script,
    });
    Ok(())
}

/// Answer a pending prompt.
#[tauri::command]
pub fn provider_auth_answer(
    state: State<'_, ProviderAuthState>,
    request_id: String,
    value: String,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "provider auth lock is poisoned".to_owned())?;
    let session = guard.as_mut().ok_or("no login is in progress")?;
    let message = serde_json::json!({
        "kind": "answer",
        "requestId": request_id,
        "value": value,
    });
    writeln!(session.stdin, "{message}")
        .and_then(|_| session.stdin.flush())
        .map_err(|error| format!("failed to answer the login prompt: {error}"))
}

/// Cancel the active login. Asks the helper to abort so pi can shut its callback
/// server down cleanly, then drops the session (killing the child regardless).
#[tauri::command]
pub fn provider_auth_cancel(state: State<'_, ProviderAuthState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "provider auth lock is poisoned".to_owned())?;
    if let Some(session) = guard.as_mut() {
        let _ = writeln!(session.stdin, r#"{{"kind":"cancel"}}"#);
        let _ = session.stdin.flush();
    }
    guard.take();
    Ok(())
}
