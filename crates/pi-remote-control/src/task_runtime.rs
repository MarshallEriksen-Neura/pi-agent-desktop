//! Dedicated, bounded Pi runtime for remote tasks.
//!
//! This module deliberately does not share the desktop `PiProc`.  A remote
//! task gets one short-lived `PiProcess`, a fixed RPC launch shape, and two
//! bounded hand-off lanes.  The process callback only performs `try_send` and
//! atomic bookkeeping; it never waits for a WebSocket, storage, or domain
//! consumer.

use crate::protocol::{
    validate_relative_path, RemoteInteractionKind, RemoteInteractionOption,
    RemoteInteractionRequest, RemoteInteractionResponseValue, RemoteTaskContextFile,
    MAX_CONTEXT_FILES, MAX_EVENT_FRAGMENT_BYTES, MAX_PROMPT_BYTES, MAX_RELATIVE_PATH_BYTES,
};
use pi_backend_core::pi_process::{
    ExitReason, LaunchSpec, PiProcess, ProcessDiagnostic, ProcessEvent, ProcessExit, ProcessLimits,
};
use pi_backend_core::projects::{canonical_project_root, resolve_existing_relative_path};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_EXECUTION_DEADLINE: Duration = Duration::from_secs(60 * 60);
pub const DEFAULT_STOP_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_CONTROL_LANE_CAPACITY: usize = 64;
pub const DEFAULT_OUTPUT_LANE_CAPACITY: usize = 128;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
pub const DEFAULT_MAX_COALESCED_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub struct RemoteTaskRuntimeConfig {
    /// Host-owned binary and fixed arguments. These are never accepted from a
    /// mobile request.
    pub pi_binary: OsString,
    pub fixed_args: Vec<OsString>,
    pub process_limits: ProcessLimits,
    pub execution_deadline: Duration,
    pub stop_timeout: Duration,
    pub control_lane_capacity: usize,
    pub output_lane_capacity: usize,
    pub max_output_bytes: usize,
    pub max_coalesced_output_bytes: usize,
}

impl Default for RemoteTaskRuntimeConfig {
    fn default() -> Self {
        Self {
            pi_binary: OsString::from("pi"),
            fixed_args: vec![
                OsString::from("--mode"),
                OsString::from("rpc"),
                OsString::from("--no-session"),
            ],
            process_limits: ProcessLimits::default(),
            execution_deadline: DEFAULT_EXECUTION_DEADLINE,
            stop_timeout: DEFAULT_STOP_TIMEOUT,
            control_lane_capacity: DEFAULT_CONTROL_LANE_CAPACITY,
            output_lane_capacity: DEFAULT_OUTPUT_LANE_CAPACITY,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            max_coalesced_output_bytes: DEFAULT_MAX_COALESCED_OUTPUT_BYTES,
        }
    }
}

impl RemoteTaskRuntimeConfig {
    /// Test/host composition helper. The runtime still owns all arguments;
    /// callers cannot supply arguments through `RemoteTaskInput`.
    pub fn with_fixed_command(
        program: impl Into<OsString>,
        args: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        let mut config = Self::default();
        config.pi_binary = program.into();
        config.fixed_args = args.into_iter().map(Into::into).collect();
        config
    }

    fn bounded(self) -> Self {
        let defaults = Self::default();
        Self {
            pi_binary: if self.pi_binary.is_empty() {
                defaults.pi_binary
            } else {
                self.pi_binary
            },
            fixed_args: if self.fixed_args.is_empty() {
                defaults.fixed_args
            } else {
                self.fixed_args
            },
            process_limits: self.process_limits,
            execution_deadline: if self.execution_deadline.is_zero()
                || self.execution_deadline > DEFAULT_EXECUTION_DEADLINE
            {
                defaults.execution_deadline
            } else {
                self.execution_deadline
            },
            stop_timeout: if self.stop_timeout.is_zero() || self.stop_timeout > DEFAULT_STOP_TIMEOUT
            {
                defaults.stop_timeout
            } else {
                self.stop_timeout
            },
            control_lane_capacity: bounded_capacity(
                self.control_lane_capacity,
                DEFAULT_CONTROL_LANE_CAPACITY,
            ),
            output_lane_capacity: bounded_capacity(
                self.output_lane_capacity,
                DEFAULT_OUTPUT_LANE_CAPACITY,
            ),
            max_output_bytes: bounded_capacity(self.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES),
            max_coalesced_output_bytes: bounded_capacity(
                self.max_coalesced_output_bytes,
                DEFAULT_MAX_COALESCED_OUTPUT_BYTES,
            ),
        }
    }
}

fn bounded_capacity(value: usize, default: usize) -> usize {
    if value == 0 || value > default {
        default
    } else {
        value
    }
}

#[derive(Clone, Debug)]
pub struct RemoteTaskInput {
    pub task_id: String,
    pub project_root: PathBuf,
    pub prompt: String,
    pub context_files: Vec<RemoteTaskContextFile>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeOutputStream {
    Stdout,
    Stderr,
    /// Structured tool-call metadata (compact JSON, see [`classify_tool_event`]).
    /// Kept on a distinct stream so the phone can render a tool card instead of
    /// interleaving the payload into assistant prose.
    Tool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeTerminal {
    Succeeded,
    Cancelled,
    TimedOut,
    Failed { code: &'static str },
    EventBackpressure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeEvent {
    Output {
        stream: RuntimeOutputStream,
        fragment: String,
    },
    InteractionRequested(RemoteInteractionRequest),
    ProtocolState {
        event_type: String,
    },
    Diagnostic {
        code: &'static str,
    },
    Terminal {
        reason: RuntimeTerminal,
    },
    OutputTruncated {
        dropped: u64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeOutcome {
    pub terminal: RuntimeTerminal,
    pub output_bytes: usize,
    pub output_dropped: u64,
    pub process_exit: Option<ProcessExit>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidInput,
    InvalidContext,
    SpawnFailed,
    AlreadyFinished,
    ResponseRejected,
    WaitTimeout,
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidInput => "remote task input is invalid",
            Self::InvalidContext => "remote task context is unavailable",
            Self::SpawnFailed => "remote task process could not be started",
            Self::AlreadyFinished => "remote task runtime has already finished",
            Self::ResponseRejected => "remote interaction response was rejected",
            Self::WaitTimeout => "remote task runtime did not stop before the deadline",
        })
    }
}

impl std::error::Error for RuntimeError {}

struct RuntimeShared {
    cancelled: AtomicBool,
    control_saturated: AtomicBool,
    output_dropped: AtomicU64,
    output_bytes: AtomicU64,
    coalesced_output: Mutex<String>,
    pending_interactions: Mutex<HashMap<String, RemoteInteractionKind>>,
    process: Mutex<Option<Arc<PiProcess>>>,
    config: RemoteTaskRuntimeConfig,
}

struct EventLanes {
    control: SyncSender<ControlEvent>,
    output: SyncSender<OutputEvent>,
    shared: Arc<RuntimeShared>,
}

#[derive(Debug)]
enum ControlEvent {
    Protocol(String),
    Exit(ProcessExit),
    Diagnostic(ProcessDiagnostic),
}

#[derive(Debug)]
struct OutputEvent {
    stream: RuntimeOutputStream,
    text: String,
}

impl EventLanes {
    fn offer_control(&self, event: ControlEvent) {
        if self.shared.control_saturated.load(Ordering::Acquire) {
            return;
        }
        if let Err(TrySendError::Full(_)) = self.control.try_send(event) {
            self.shared.control_saturated.store(true, Ordering::Release);
        }
    }

    fn offer_output(&self, event: OutputEvent) {
        let event = match self.output.try_send(event) {
            Ok(()) => return,
            Err(TrySendError::Full(event)) => event,
            Err(TrySendError::Disconnected(event)) => event,
        };
        self.shared.output_dropped.fetch_add(1, Ordering::Relaxed);
        // Only stdout coalesces. `coalesced_output` is flushed as a single
        // `Stdout` event, so folding a structured `Tool` payload (or a stderr
        // line) into it would both lose the stream tag and splice JSON into
        // assistant prose. Those streams are dropped instead — the drop is
        // already counted above and surfaced via `OutputTruncated`.
        if !matches!(event.stream, RuntimeOutputStream::Stdout) {
            return;
        }
        if let Ok(mut coalesced) = self.shared.coalesced_output.try_lock() {
            let remaining = self
                .shared
                .config
                .max_coalesced_output_bytes
                .saturating_sub(coalesced.len());
            if remaining > 0 {
                let fragment = event.text.chars().take(remaining).collect::<String>();
                coalesced.push_str(&fragment);
            }
        }
    }
}

pub struct RemoteTaskRuntime {
    shared: Arc<RuntimeShared>,
    done: Mutex<Option<Receiver<RuntimeOutcome>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RemoteTaskRuntime {
    pub fn start(
        input: RemoteTaskInput,
        config: RemoteTaskRuntimeConfig,
        event_sink: impl Fn(RuntimeEvent) + Send + Sync + 'static,
    ) -> Result<Self, RuntimeError> {
        let config = config.bounded();
        let launch = build_launch(&input, &config)?;
        let (control_tx, control_rx) = mpsc::sync_channel(config.control_lane_capacity);
        let (output_tx, output_rx) = mpsc::sync_channel(config.output_lane_capacity);
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let shared = Arc::new(RuntimeShared {
            cancelled: AtomicBool::new(false),
            control_saturated: AtomicBool::new(false),
            output_dropped: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            coalesced_output: Mutex::new(String::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            process: Mutex::new(None),
            config: config.clone(),
        });
        let lanes = EventLanes {
            control: control_tx,
            output: output_tx,
            shared: Arc::clone(&shared),
        };
        let callback_lanes = lanes;
        let process =
            PiProcess::spawn(
                1,
                &launch,
                config.process_limits.clone(),
                move |event| match event {
                    ProcessEvent::Stdout(line) => classify_stdout(line, &callback_lanes),
                    ProcessEvent::Stderr(line) => callback_lanes.offer_output(OutputEvent {
                        stream: RuntimeOutputStream::Stderr,
                        text: line,
                    }),
                    ProcessEvent::Exit(exit) => {
                        callback_lanes.offer_control(ControlEvent::Exit(exit))
                    }
                    ProcessEvent::Diagnostic(diagnostic) => {
                        callback_lanes.offer_control(ControlEvent::Diagnostic(diagnostic))
                    }
                },
            )
            .map_err(|_| RuntimeError::SpawnFailed)?;
        let process = Arc::new(process);
        *shared
            .process
            .lock()
            .map_err(|_| RuntimeError::SpawnFailed)? = Some(Arc::clone(&process));

        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("remote-task-runtime".into())
            .spawn(move || {
                let outcome = run_worker(
                    worker_shared,
                    process,
                    input,
                    control_rx,
                    output_rx,
                    event_sink,
                );
                let _ = done_tx.try_send(outcome);
            })
            .map_err(|_| RuntimeError::SpawnFailed)?;
        Ok(Self {
            shared,
            done: Mutex::new(Some(done_rx)),
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn cancel(&self) {
        self.shared.cancelled.store(true, Ordering::Release);
    }

    pub fn respond(&self, response: RemoteTaskResponse) -> Result<(), RuntimeError> {
        if response.interaction_id.is_empty()
            || response.interaction_id.len() > 128
            || response.interaction_id.chars().any(char::is_control)
        {
            return Err(RuntimeError::ResponseRejected);
        }
        if let RemoteInteractionResponseValue::Text(value) = &response.value {
            if value.is_empty()
                || value.len() > crate::protocol::MAX_INTERACTION_VALUE_BYTES
                || value.chars().any(char::is_control)
            {
                return Err(RuntimeError::ResponseRejected);
            }
        }
        let kind = self
            .shared
            .pending_interactions
            .lock()
            .ok()
            .and_then(|pending| pending.get(&response.interaction_id).cloned());
        let Some(kind) = kind else {
            return Err(RuntimeError::ResponseRejected);
        };
        let protocol = match (&kind, &response.value) {
            (
                RemoteInteractionKind::Confirm,
                RemoteInteractionResponseValue::Boolean(confirmed),
            ) => {
                serde_json::json!({"type":"extension_ui_response","id":response.interaction_id,"confirmed":confirmed})
            }
            (
                RemoteInteractionKind::Select
                | RemoteInteractionKind::Input
                | RemoteInteractionKind::Editor,
                RemoteInteractionResponseValue::Text(value),
            ) => {
                serde_json::json!({"type":"extension_ui_response","id":response.interaction_id,"value":value})
            }
            _ => return Err(RuntimeError::ResponseRejected),
        };
        let line = serde_json::to_string(&protocol).map_err(|_| RuntimeError::ResponseRejected)?;
        let process = self
            .shared
            .process
            .lock()
            .ok()
            .and_then(|process| process.clone())
            .ok_or(RuntimeError::AlreadyFinished)?;
        process
            .send_json_line(&line)
            .map_err(|_| RuntimeError::ResponseRejected)?;
        if let Ok(mut pending) = self.shared.pending_interactions.lock() {
            pending.remove(&response.interaction_id);
        }
        Ok(())
    }

    pub fn wait(&self, timeout: Duration) -> Result<RuntimeOutcome, RuntimeError> {
        let receiver = self
            .done
            .lock()
            .map_err(|_| RuntimeError::AlreadyFinished)?
            .take()
            .ok_or(RuntimeError::AlreadyFinished)?;
        let outcome = receiver
            .recv_timeout(timeout)
            .map_err(|_| RuntimeError::WaitTimeout)?;
        if let Some(worker) = self.worker.lock().ok().and_then(|mut worker| worker.take()) {
            let _ = worker.join();
        }
        Ok(outcome)
    }
}

impl Drop for RemoteTaskRuntime {
    fn drop(&mut self) {
        self.cancel();
        // The worker owns the PiProcess and will perform bounded process-tree
        // cleanup. Do not join here: Drop must never inherit a downstream
        // consumer's latency.
    }
}

#[derive(Clone, Debug)]
pub struct RemoteTaskResponse {
    pub interaction_id: String,
    pub value: RemoteInteractionResponseValue,
}

fn build_launch(
    input: &RemoteTaskInput,
    config: &RemoteTaskRuntimeConfig,
) -> Result<LaunchSpec, RuntimeError> {
    if input.task_id.is_empty()
        || input.task_id.len() > 128
        || input.task_id.chars().any(char::is_control)
        || input.prompt.is_empty()
        || input.prompt.len() > MAX_PROMPT_BYTES
        || input.prompt.chars().any(char::is_control)
        || input.context_files.len() > MAX_CONTEXT_FILES
    {
        return Err(RuntimeError::InvalidInput);
    }
    let root =
        canonical_project_root(&input.project_root).map_err(|_| RuntimeError::InvalidContext)?;
    for file in &input.context_files {
        validate_relative_path(&file.relative_path).map_err(|_| RuntimeError::InvalidContext)?;
        if file.relative_path.len() > MAX_RELATIVE_PATH_BYTES
            || denied_context_path(&file.relative_path)
        {
            return Err(RuntimeError::InvalidContext);
        }
        let target = resolve_existing_relative_path(
            &root,
            Path::new(&file.relative_path),
            MAX_RELATIVE_PATH_BYTES,
        )
        .map_err(|_| RuntimeError::InvalidContext)?;
        let link_metadata = fs::symlink_metadata(root.join(&file.relative_path))
            .map_err(|_| RuntimeError::InvalidContext)?;
        if is_link_or_reparse(&link_metadata) || !target.is_file() {
            return Err(RuntimeError::InvalidContext);
        }
    }
    let mut launch = LaunchSpec::new(config.pi_binary.clone()).current_dir(root);
    for arg in &config.fixed_args {
        launch = launch.arg(arg.clone());
    }
    Ok(launch)
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn denied_context_path(path: &str) -> bool {
    path.split('/').any(|part| {
        let lower = part.to_ascii_lowercase();
        lower == ".git"
            || lower == "node_modules"
            || lower == "target"
            || lower.starts_with(".env")
            || lower.ends_with(".pem")
            || lower.ends_with(".key")
    })
}

fn build_prompt(input: &RemoteTaskInput) -> String {
    let references = input
        .context_files
        .iter()
        .map(|file| format!("- {}", file.relative_path))
        .collect::<Vec<_>>()
        .join("\n");
    if references.is_empty() {
        input.prompt.clone()
    } else {
        format!(
            "{}\n\nContext files (relative to the selected project):\n{}",
            input.prompt, references
        )
    }
}

#[derive(Serialize)]
struct PromptCommand<'a> {
    #[serde(rename = "type")]
    command_type: &'static str,
    message: &'a str,
}

fn run_worker(
    shared: Arc<RuntimeShared>,
    process: Arc<PiProcess>,
    input: RemoteTaskInput,
    control_rx: Receiver<ControlEvent>,
    output_rx: Receiver<OutputEvent>,
    event_sink: impl Fn(RuntimeEvent),
) -> RuntimeOutcome {
    let prompt = build_prompt(&input);
    let prompt_line = match serde_json::to_string(&PromptCommand {
        command_type: "prompt",
        message: &prompt,
    }) {
        Ok(line) => line,
        Err(_) => return failed(&event_sink, &shared, "prompt_encode_failed", None),
    };
    if process.send_json_line(&prompt_line).is_err() {
        return failed(&event_sink, &shared, "prompt_send_failed", None);
    }
    let deadline = Instant::now() + shared.config.execution_deadline;
    let mut process_exit = None;
    let mut terminal = None;
    while terminal.is_none() {
        if shared.control_saturated.load(Ordering::Acquire) {
            terminal = Some(RuntimeTerminal::EventBackpressure);
        } else if shared.cancelled.load(Ordering::Acquire) {
            terminal = Some(RuntimeTerminal::Cancelled);
        } else if Instant::now() >= deadline {
            terminal = Some(RuntimeTerminal::TimedOut);
        }
        if terminal.is_some() {
            break;
        }

        match control_rx.recv_timeout(Duration::from_millis(25)) {
            Ok(ControlEvent::Protocol(line)) => {
                match handle_protocol(&shared, &input.task_id, &line, &event_sink) {
                    ProtocolAction::Continue => {}
                    ProtocolAction::Succeeded => terminal = Some(RuntimeTerminal::Succeeded),
                    ProtocolAction::Failed => {
                        terminal = Some(RuntimeTerminal::Failed {
                            code: "protocol_failed",
                        })
                    }
                }
            }
            Ok(ControlEvent::Exit(exit)) => {
                process_exit = Some(exit.clone());
                terminal = Some(
                    if exit.reason == ExitReason::Stopped
                        && shared.cancelled.load(Ordering::Acquire)
                    {
                        RuntimeTerminal::Cancelled
                    } else {
                        RuntimeTerminal::Failed {
                            code: "process_exited",
                        }
                    },
                );
            }
            Ok(ControlEvent::Diagnostic(diagnostic)) => event_sink(RuntimeEvent::Diagnostic {
                code: diagnostic.code,
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                terminal = Some(RuntimeTerminal::Failed {
                    code: "control_lane_closed",
                })
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        while let Ok(output) = output_rx.try_recv() {
            emit_output(&shared, &event_sink, output);
        }
        flush_coalesced(&shared, &event_sink);
    }
    let terminal = terminal.unwrap_or(RuntimeTerminal::Failed {
        code: "runtime_stopped",
    });
    if matches!(terminal, RuntimeTerminal::EventBackpressure) {
        event_sink(RuntimeEvent::Diagnostic {
            code: "event_backpressure",
        });
    }
    if !matches!(terminal, RuntimeTerminal::Succeeded) || process_exit.is_none() {
        process_exit = process.stop(shared.config.stop_timeout).ok();
    }
    drain_output(&shared, &output_rx, &event_sink);
    let output_dropped = shared.output_dropped.load(Ordering::Relaxed);
    if output_dropped > 0 {
        event_sink(RuntimeEvent::OutputTruncated {
            dropped: output_dropped,
        });
    }
    event_sink(RuntimeEvent::Terminal {
        reason: terminal.clone(),
    });
    RuntimeOutcome {
        terminal,
        output_bytes: shared.output_bytes.load(Ordering::Relaxed) as usize,
        output_dropped,
        process_exit,
    }
}

fn failed(
    sink: &impl Fn(RuntimeEvent),
    shared: &RuntimeShared,
    _code: &'static str,
    process_exit: Option<ProcessExit>,
) -> RuntimeOutcome {
    let terminal = RuntimeTerminal::Failed {
        code: "runtime_failed",
    };
    sink(RuntimeEvent::Terminal {
        reason: terminal.clone(),
    });
    RuntimeOutcome {
        terminal,
        output_bytes: shared.output_bytes.load(Ordering::Relaxed) as usize,
        output_dropped: shared.output_dropped.load(Ordering::Relaxed),
        process_exit,
    }
}

enum ProtocolAction {
    Continue,
    Succeeded,
    Failed,
}

fn handle_protocol(
    shared: &RuntimeShared,
    task_id: &str,
    line: &str,
    sink: &impl Fn(RuntimeEvent),
) -> ProtocolAction {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return ProtocolAction::Failed;
    };
    let Some(event_type) = value.get("type").and_then(Value::as_str) else {
        return ProtocolAction::Failed;
    };
    if event_type == "agent_end" {
        sink(RuntimeEvent::ProtocolState {
            event_type: event_type.to_owned(),
        });
        return ProtocolAction::Succeeded;
    }
    if event_type == "extension_ui_request" {
        if let Some(request) = parse_interaction(&value, task_id) {
            if let Ok(mut pending) = shared.pending_interactions.lock() {
                if pending.len() >= 32 {
                    return ProtocolAction::Failed;
                }
                pending.insert(request.interaction_id.clone(), request.kind.clone());
            }
            sink(RuntimeEvent::InteractionRequested(request));
            return ProtocolAction::Continue;
        }
        return ProtocolAction::Failed;
    }
    if event_type == "response" && value.get("success").and_then(Value::as_bool) == Some(false) {
        return ProtocolAction::Failed;
    }
    sink(RuntimeEvent::ProtocolState {
        event_type: event_type.to_owned(),
    });
    ProtocolAction::Continue
}

fn parse_interaction(value: &Value, task_id: &str) -> Option<RemoteInteractionRequest> {
    let method = value.get("method")?.as_str()?;
    let kind = match method {
        "confirm" => RemoteInteractionKind::Confirm,
        "select" => RemoteInteractionKind::Select,
        "input" => RemoteInteractionKind::Input,
        "editor" => RemoteInteractionKind::Editor,
        _ => return None,
    };
    let now = now_ms();
    let timeout_ms = value
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(5 * 60 * 1000)
        .min(DEFAULT_EXECUTION_DEADLINE.as_millis() as u64);
    let options = value.get("options").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .take(32)
            .map(|label| RemoteInteractionOption {
                label: label.to_owned(),
                value: label.to_owned(),
            })
            .collect::<Vec<_>>()
    });
    let request = RemoteInteractionRequest {
        interaction_id: value.get("id")?.as_str()?.to_owned(),
        task_id: task_id.to_owned(),
        kind,
        prompt: value
            .get("message")
            .or_else(|| value.get("title"))
            .and_then(Value::as_str)
            .unwrap_or("Pi requested input")
            .chars()
            .take(16 * 1024)
            .collect(),
        options,
        created_at: timestamp(now),
        expires_at: timestamp(now.saturating_add(timeout_ms)),
    };
    request.validate().ok()?;
    Some(request)
}

fn classify_stdout(line: String, lanes: &EventLanes) {
    let Ok(value) = serde_json::from_str::<Value>(&line) else {
        lanes.offer_control(ControlEvent::Protocol(line));
        return;
    };
    if value.get("type").and_then(Value::as_str) == Some("message_update") {
        if let Some(event) = value.get("assistantMessageEvent") {
            if matches!(
                event.get("type").and_then(Value::as_str),
                Some("text_delta" | "thinking_delta")
            ) {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    lanes.offer_output(OutputEvent {
                        stream: RuntimeOutputStream::Stdout,
                        text: delta.to_owned(),
                    });
                    return;
                }
            }
        }
    }
    if let Some(payload) = classify_tool_event(&value) {
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Tool,
            text: payload,
        });
        return;
    }
    lanes.offer_control(ControlEvent::Protocol(line));
}

/// Maximum length of a serialized tool payload. `emit_output` truncates by char
/// count, which would corrupt JSON mid-object, so the payload is kept well under
/// `MAX_EVENT_FRAGMENT_BYTES` and the path field is clipped to fit.
const MAX_TOOL_PAYLOAD_CHARS: usize = 200;
/// Budget for the clipped path/command field inside a tool payload.
const MAX_TOOL_TARGET_CHARS: usize = 120;

/// Translate a pi CLI `tool_execution_start` / `tool_execution_end` line into a
/// compact JSON payload for the phone: `{"n":<tool>,"p":<target>,"e":<0|1>}`.
///
/// `tool_execution_update` is deliberately ignored — its `partialResult` is a
/// full replacement (not a delta), so forwarding it would repeatedly re-send the
/// whole accumulated result and flood the stream.
///
/// Returns `None` for any line that is not a terminal tool event, leaving it on
/// the control lane so `handle_protocol` keeps its existing semantics.
fn classify_tool_event(value: &Value) -> Option<String> {
    let event_type = value.get("type").and_then(Value::as_str)?;
    let ended = match event_type {
        "tool_execution_start" => false,
        "tool_execution_end" => true,
        _ => return None,
    };

    let name: String = value
        .get("toolName")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .chars()
        .take(32)
        .collect();

    // Pull the most human-meaningful identifier out of `args`: a file path for
    // read/edit-style tools, a command line for shell tools.
    let target: String = value
        .get("args")
        .and_then(|args| {
            ["path", "file_path", "filePath", "command", "pattern"]
                .iter()
                .find_map(|key| args.get(key).and_then(Value::as_str))
        })
        .unwrap_or("")
        .chars()
        .take(MAX_TOOL_TARGET_CHARS)
        .collect();

    let is_error = value
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let payload = serde_json::to_string(&ToolEventPayload {
        name: &name,
        target: &target,
        ended,
        is_error,
    })
    .ok()?;

    // Defensive: if the payload still exceeds the cap (unexpected escaping
    // blow-up), drop it rather than emit JSON that will arrive truncated.
    if payload.chars().count() > MAX_TOOL_PAYLOAD_CHARS {
        return None;
    }
    Some(payload)
}

#[derive(Serialize)]
struct ToolEventPayload<'a> {
    #[serde(rename = "n")]
    name: &'a str,
    #[serde(rename = "p", skip_serializing_if = "str::is_empty")]
    target: &'a str,
    #[serde(rename = "d")]
    ended: bool,
    #[serde(rename = "e", skip_serializing_if = "std::ops::Not::not")]
    is_error: bool,
}

fn emit_output(shared: &RuntimeShared, sink: &impl Fn(RuntimeEvent), output: OutputEvent) {
    let remaining = shared
        .config
        .max_output_bytes
        .saturating_sub(shared.output_bytes.load(Ordering::Relaxed) as usize);
    if remaining == 0 {
        shared.output_dropped.fetch_add(1, Ordering::Relaxed);
        return;
    }
    let fragment = output
        .text
        .chars()
        .take(remaining.min(MAX_EVENT_FRAGMENT_BYTES))
        .collect::<String>();
    shared
        .output_bytes
        .fetch_add(fragment.len() as u64, Ordering::Relaxed);
    sink(RuntimeEvent::Output {
        stream: output.stream,
        fragment,
    });
}

fn flush_coalesced(shared: &RuntimeShared, sink: &impl Fn(RuntimeEvent)) {
    let text = shared
        .coalesced_output
        .try_lock()
        .ok()
        .map(|mut value| std::mem::take(&mut *value));
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        emit_output(
            shared,
            sink,
            OutputEvent {
                stream: RuntimeOutputStream::Stdout,
                text,
            },
        );
    }
}

fn drain_output(
    shared: &RuntimeShared,
    receiver: &Receiver<OutputEvent>,
    sink: &impl Fn(RuntimeEvent),
) {
    while let Ok(output) = receiver.try_recv() {
        emit_output(shared, sink, output);
    }
    flush_coalesced(shared, sink);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn timestamp(ms: u64) -> String {
    let seconds = ms / 1000;
    let millis = ms % 1000;
    let days = seconds / 86_400;
    let day_seconds = seconds % 86_400;
    let z = days as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day_seconds / 3_600,
        (day_seconds % 3_600) / 60,
        day_seconds % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_launch_never_contains_client_session_or_args() {
        let root = std::env::temp_dir();
        let input = RemoteTaskInput {
            task_id: "task-1".into(),
            project_root: root,
            prompt: "inspect".into(),
            context_files: Vec::new(),
        };
        let config =
            RemoteTaskRuntimeConfig::with_fixed_command("pi", ["--mode", "rpc", "--no-session"]);
        let launch = build_launch(&input, &config).unwrap();
        assert_eq!(
            launch.args,
            ["--mode", "rpc", "--no-session"]
                .map(OsString::from)
                .to_vec()
        );
    }

    #[test]
    fn control_lane_saturation_is_fail_closed_and_nonblocking() {
        let config = RemoteTaskRuntimeConfig {
            control_lane_capacity: 1,
            ..RemoteTaskRuntimeConfig::default()
        };
        let shared = Arc::new(RuntimeShared {
            cancelled: AtomicBool::new(false),
            control_saturated: AtomicBool::new(false),
            output_dropped: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            coalesced_output: Mutex::new(String::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            process: Mutex::new(None),
            config,
        });
        let (tx, _rx) = mpsc::sync_channel(1);
        let lanes = EventLanes {
            control: tx,
            output: mpsc::sync_channel(1).0,
            shared: Arc::clone(&shared),
        };
        lanes.offer_control(ControlEvent::Protocol("{}".into()));
        let started = Instant::now();
        lanes.offer_control(ControlEvent::Protocol("{}".into()));
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(shared.control_saturated.load(Ordering::Acquire));
    }

    #[test]
    fn output_lane_saturation_is_bounded_and_observable() {
        let config = RemoteTaskRuntimeConfig {
            output_lane_capacity: 1,
            max_coalesced_output_bytes: 8,
            ..RemoteTaskRuntimeConfig::default()
        };
        let shared = Arc::new(RuntimeShared {
            cancelled: AtomicBool::new(false),
            control_saturated: AtomicBool::new(false),
            output_dropped: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            coalesced_output: Mutex::new(String::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            process: Mutex::new(None),
            config,
        });
        let (control, _) = mpsc::sync_channel(1);
        let (output, output_rx) = mpsc::sync_channel(1);
        let lanes = EventLanes {
            control,
            output,
            shared: Arc::clone(&shared),
        };
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Stdout,
            text: "first".into(),
        });
        let _keep_receiver_alive = output_rx;
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Stdout,
            text: "second".into(),
        });
        assert_eq!(shared.output_dropped.load(Ordering::Acquire), 1);
        assert_eq!(shared.coalesced_output.lock().unwrap().as_str(), "second");
    }

    #[test]
    fn tool_start_and_end_become_compact_payloads() {
        let start = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "t-1",
            "toolName": "edit",
            "args": {"file_path": "src/auth/login.ts"}
        });
        let payload = classify_tool_event(&start).expect("start is a tool event");
        assert_eq!(payload, r#"{"n":"edit","p":"src/auth/login.ts","d":false}"#);

        let end = serde_json::json!({
            "type": "tool_execution_end",
            "toolCallId": "t-1",
            "toolName": "bash",
            "args": {"command": "pnpm test"},
            "isError": true
        });
        let payload = classify_tool_event(&end).expect("end is a tool event");
        assert_eq!(payload, r#"{"n":"bash","p":"pnpm test","d":true,"e":true}"#);
    }

    #[test]
    fn non_terminal_tool_events_stay_on_control_lane() {
        // `tool_execution_update` carries a full replacement result, not a
        // delta — forwarding it would flood the stream.
        let update = serde_json::json!({
            "type": "tool_execution_update",
            "toolCallId": "t-1",
            "partialResult": "half"
        });
        assert!(classify_tool_event(&update).is_none());
        let unrelated = serde_json::json!({"type": "agent_end"});
        assert!(classify_tool_event(&unrelated).is_none());
    }

    #[test]
    fn tool_payload_target_is_clipped_to_stay_under_fragment_cap() {
        let long_path = "a/".repeat(400);
        let start = serde_json::json!({
            "type": "tool_execution_start",
            "toolName": "read",
            "args": {"path": long_path}
        });
        let payload = classify_tool_event(&start).expect("still a tool event");
        assert!(payload.chars().count() <= MAX_TOOL_PAYLOAD_CHARS);
        assert!(payload.chars().count() < MAX_EVENT_FRAGMENT_BYTES);
        // Valid JSON survives the clip — the phone must be able to parse it.
        let parsed: Value = serde_json::from_str(&payload).expect("payload is valid JSON");
        assert_eq!(parsed.get("n").and_then(Value::as_str), Some("read"));
    }

    #[test]
    fn saturated_output_lane_never_coalesces_tool_payloads_into_stdout() {
        // `coalesced_output` is flushed as a single Stdout event. A dropped Tool
        // payload must not be spliced into assistant prose.
        let config = RemoteTaskRuntimeConfig {
            max_coalesced_output_bytes: 256,
            ..RemoteTaskRuntimeConfig::default()
        };
        let shared = Arc::new(RuntimeShared {
            cancelled: AtomicBool::new(false),
            control_saturated: AtomicBool::new(false),
            output_dropped: AtomicU64::new(0),
            output_bytes: AtomicU64::new(0),
            coalesced_output: Mutex::new(String::new()),
            pending_interactions: Mutex::new(HashMap::new()),
            process: Mutex::new(None),
            config,
        });
        let (control, _control_rx) = mpsc::sync_channel(1);
        let (output, output_rx) = mpsc::sync_channel(1);
        let lanes = EventLanes {
            control,
            output,
            shared: Arc::clone(&shared),
        };
        // Fill the single-slot lane so subsequent offers are dropped.
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Stdout,
            text: "prose".into(),
        });
        let _keep_receiver_alive = output_rx;
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Tool,
            text: r#"{"n":"edit","p":"a.ts","d":true}"#.into(),
        });
        lanes.offer_output(OutputEvent {
            stream: RuntimeOutputStream::Stderr,
            text: "warn: something".into(),
        });
        // Both drops are counted, but neither polluted the stdout buffer.
        assert_eq!(shared.output_dropped.load(Ordering::Acquire), 2);
        assert_eq!(shared.coalesced_output.lock().unwrap().as_str(), "");
    }

    #[test]
    fn interaction_is_translated_to_bounded_remote_dto() {
        let value = serde_json::json!({"type":"extension_ui_request","id":"i-1","method":"select","message":"Choose","options":["a","b"],"timeout":1000});
        let request = parse_interaction(&value, "task-1").unwrap();
        assert_eq!(request.kind, RemoteInteractionKind::Select);
        assert_eq!(request.options.unwrap().len(), 2);
        assert!(request.expires_at > request.created_at);
    }
}
