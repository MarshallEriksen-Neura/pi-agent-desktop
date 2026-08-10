use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use thiserror::Error;

const DEFAULT_MAX_INPUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_LINE_BYTES: usize = 1024 * 1024;
const DEFAULT_COMMAND_CAPACITY: usize = 64;
const DEFAULT_EVENT_CAPACITY: usize = 256;
const DEFAULT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaunchSpec {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(OsString, Option<OsString>)>,
    pub create_no_window: bool,
}

impl LaunchSpec {
    pub fn new(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            create_no_window: true,
        }
    }

    pub fn from_command(command: &Command) -> Self {
        Self {
            program: command.get_program().to_os_string(),
            args: command.get_args().map(OsStr::to_os_string).collect(),
            cwd: command.get_current_dir().map(Path::to_path_buf),
            env: command
                .get_envs()
                .map(|(key, value)| (key.to_os_string(), value.map(OsStr::to_os_string)))
                .collect(),
            create_no_window: true,
        }
    }

    pub fn arg(mut self, value: impl Into<OsString>) -> Self {
        self.args.push(value.into());
        self
    }

    pub fn current_dir(mut self, value: impl Into<PathBuf>) -> Self {
        self.cwd = Some(value.into());
        self
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command.args(&self.args);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        for (key, value) in &self.env {
            match value {
                Some(value) => {
                    command.env(key, value);
                }
                None => {
                    command.env_remove(key);
                }
            }
        }
        command
    }
}

#[derive(Clone, Debug)]
pub struct ProcessLimits {
    pub max_input_bytes: usize,
    pub max_output_line_bytes: usize,
    pub command_capacity: usize,
    pub event_capacity: usize,
    pub write_timeout: Duration,
    pub poll_interval: Duration,
}

impl Default for ProcessLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: DEFAULT_MAX_INPUT_BYTES,
            max_output_line_bytes: DEFAULT_MAX_OUTPUT_LINE_BYTES,
            command_capacity: DEFAULT_COMMAND_CAPACITY,
            event_capacity: DEFAULT_EVENT_CAPACITY,
            write_timeout: DEFAULT_WRITE_TIMEOUT,
            poll_interval: DEFAULT_POLL_INTERVAL,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessPhase {
    Running,
    Stopping,
    Exited,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitReason {
    Natural,
    Stopped,
    CleanupFailed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessExit {
    pub generation: u64,
    pub code: Option<i32>,
    pub reason: ExitReason,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSnapshot {
    pub generation: u64,
    pub pid: u32,
    pub phase: ProcessPhase,
    pub last_exit: Option<ProcessExit>,
    pub dropped_events: u64,
    pub last_error_code: Option<String>,
}

impl ProcessSnapshot {
    pub fn is_terminal(&self) -> bool {
        matches!(self.phase, ProcessPhase::Exited | ProcessPhase::Failed)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessEvent {
    Stdout(String),
    Stderr(String),
    Exit(ProcessExit),
    Diagnostic(ProcessDiagnostic),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessDiagnostic {
    pub generation: u64,
    pub code: &'static str,
    pub stream: Option<OutputStream>,
    pub detail: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Error)]
pub enum ProcessError {
    #[error("process spawn failed: {0}")]
    Spawn(#[source] io::Error),
    #[error("process pipe {0} was unavailable")]
    MissingPipe(&'static str),
    #[error("process tree setup failed: {0}")]
    ProcessTree(String),
    #[error("process is not running")]
    NotRunning,
    #[error("process command queue is full")]
    Backpressure,
    #[error("process command channel is closed")]
    ChannelClosed,
    #[error("process input exceeded {limit} bytes")]
    InputTooLarge { limit: usize },
    #[error("process input must be exactly one JSON object")]
    InvalidJsonLine,
    #[error("process write timed out after {timeout_ms} ms")]
    WriteTimeout { timeout_ms: u128 },
    #[error("process write failed: {0}")]
    Write(String),
    #[error("process stop timed out after {timeout_ms} ms")]
    StopTimeout { timeout_ms: u128 },
    #[error("process stop failed: {0}")]
    Stop(String),
    #[error("process state lock is poisoned")]
    StatePoisoned,
}

enum WriterCommand {
    Write {
        bytes: Vec<u8>,
        reply: SyncSender<Result<(), String>>,
    },
    Close,
}

struct StopCommand {
    deadline: Instant,
    reply: SyncSender<Result<ProcessExit, String>>,
}

pub struct PiProcess {
    generation: u64,
    state: Arc<Mutex<ProcessSnapshot>>,
    writer: SyncSender<WriterCommand>,
    stop: SyncSender<StopCommand>,
    write_timeout: Duration,
    max_input_bytes: usize,
    owner: Mutex<Option<JoinHandle<()>>>,
}

impl PiProcess {
    pub fn spawn(
        generation: u64,
        spec: &LaunchSpec,
        limits: ProcessLimits,
        event_sink: impl Fn(ProcessEvent) + Send + Sync + 'static,
    ) -> Result<Self, ProcessError> {
        let mut command = spec.command();
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_platform_command(&mut command, spec.create_no_window);

        let mut child = command.spawn().map_err(ProcessError::Spawn)?;
        let process_tree = match ProcessTree::attach(&mut child) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ProcessError::ProcessTree(error));
            }
        };
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| missing_pipe(&mut child, "stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| missing_pipe(&mut child, "stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| missing_pipe(&mut child, "stderr"))?;

        let state = Arc::new(Mutex::new(ProcessSnapshot {
            generation,
            pid,
            phase: ProcessPhase::Running,
            last_exit: None,
            dropped_events: 0,
            last_error_code: None,
        }));
        let dropped_events = Arc::new(AtomicU64::new(0));
        let (event_tx, event_rx) = mpsc::sync_channel(limits.event_capacity.max(1));
        let dispatcher = spawn_event_dispatcher(event_rx, event_sink);
        let stdout_reader = spawn_pipe_reader(
            stdout,
            generation,
            OutputStream::Stdout,
            limits.max_output_line_bytes,
            event_tx.clone(),
            Arc::clone(&dropped_events),
        );
        let stderr_reader = spawn_pipe_reader(
            stderr,
            generation,
            OutputStream::Stderr,
            limits.max_output_line_bytes,
            event_tx.clone(),
            Arc::clone(&dropped_events),
        );
        let (writer_tx, writer_rx) = mpsc::sync_channel(limits.command_capacity.max(1));
        let writer_shutdown = Arc::new(AtomicBool::new(false));
        let writer = spawn_stdin_writer(stdin, writer_rx, Arc::clone(&writer_shutdown));
        let writer_for_owner = writer_tx.clone();
        let (stop_tx, stop_rx) = mpsc::sync_channel(1);
        let owner_state = Arc::clone(&state);
        let poll_interval = limits.poll_interval;

        let owner = thread::Builder::new()
            .name(format!("pi-process-{generation}"))
            .spawn(move || {
                run_process_owner(
                    child,
                    process_tree,
                    generation,
                    owner_state,
                    stop_rx,
                    writer_for_owner,
                    writer_shutdown,
                    writer,
                    stdout_reader,
                    stderr_reader,
                    event_tx,
                    dispatcher,
                    dropped_events,
                    poll_interval,
                );
            })
            .map_err(ProcessError::Spawn)?;

        Ok(Self {
            generation,
            state,
            writer: writer_tx,
            stop: stop_tx,
            write_timeout: limits.write_timeout,
            max_input_bytes: limits.max_input_bytes,
            owner: Mutex::new(Some(owner)),
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn snapshot(&self) -> Result<ProcessSnapshot, ProcessError> {
        self.state
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|_| ProcessError::StatePoisoned)
    }

    pub fn send_json_line(&self, line: &str) -> Result<(), ProcessError> {
        if self.snapshot()?.phase != ProcessPhase::Running {
            return Err(ProcessError::NotRunning);
        }
        let bytes = frame_json_line(line, self.max_input_bytes)?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        match self.writer.try_send(WriterCommand::Write {
            bytes,
            reply: reply_tx,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return Err(ProcessError::Backpressure),
            Err(TrySendError::Disconnected(_)) => return Err(ProcessError::ChannelClosed),
        }
        match reply_rx.recv_timeout(self.write_timeout) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(ProcessError::Write(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(ProcessError::WriteTimeout {
                timeout_ms: self.write_timeout.as_millis(),
            }),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(ProcessError::ChannelClosed),
        }
    }

    pub fn stop(&self, timeout: Duration) -> Result<ProcessExit, ProcessError> {
        let snapshot = self.snapshot()?;
        if let Some(exit) = snapshot.last_exit {
            self.join_if_finished();
            return Ok(exit);
        }
        if snapshot.phase == ProcessPhase::Stopping {
            return self.wait_for_exit(timeout);
        }
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        match self.stop.try_send(StopCommand {
            deadline: Instant::now() + timeout,
            reply: reply_tx,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => return self.wait_for_exit(timeout),
            Err(TrySendError::Disconnected(_)) => {
                return self
                    .snapshot()?
                    .last_exit
                    .ok_or(ProcessError::ChannelClosed)
            }
        }
        let exit = match reply_rx.recv_timeout(timeout) {
            Ok(Ok(exit)) => exit,
            Ok(Err(error)) => return Err(ProcessError::Stop(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err(ProcessError::StopTimeout {
                    timeout_ms: timeout.as_millis(),
                })
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return self
                    .snapshot()?
                    .last_exit
                    .ok_or(ProcessError::ChannelClosed)
            }
        };
        self.join_if_finished();
        Ok(exit)
    }

    pub fn wait_for_exit(&self, timeout: Duration) -> Result<ProcessExit, ProcessError> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(exit) = self.snapshot()?.last_exit {
                self.join_if_finished();
                return Ok(exit);
            }
            if Instant::now() >= deadline {
                return Err(ProcessError::StopTimeout {
                    timeout_ms: timeout.as_millis(),
                });
            }
            thread::sleep(DEFAULT_POLL_INTERVAL);
        }
    }

    fn join_if_finished(&self) {
        let Ok(mut owner) = self.owner.lock() else {
            return;
        };
        if owner.as_ref().is_some_and(JoinHandle::is_finished) {
            if let Some(owner) = owner.take() {
                let _ = owner.join();
            }
        }
    }
}

impl Drop for PiProcess {
    fn drop(&mut self) {
        if self
            .state
            .lock()
            .map(|snapshot| !snapshot.is_terminal())
            .unwrap_or(true)
        {
            let _ = self.stop(Duration::from_secs(2));
        }
        // Rust threads cannot be force-cancelled. Never let a blocked external
        // event sink turn destruction into an unbounded application shutdown.
        self.join_if_finished();
    }
}

pub fn frame_json_line(line: &str, max_bytes: usize) -> Result<Vec<u8>, ProcessError> {
    if line.len() > max_bytes {
        return Err(ProcessError::InputTooLarge { limit: max_bytes });
    }
    if line.contains(['\r', '\n']) {
        return Err(ProcessError::InvalidJsonLine);
    }
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|_| ProcessError::InvalidJsonLine)?;
    if !value.is_object() {
        return Err(ProcessError::InvalidJsonLine);
    }
    let mut framed = Vec::with_capacity(line.len() + 1);
    framed.extend_from_slice(line.as_bytes());
    framed.push(b'\n');
    Ok(framed)
}

fn missing_pipe(child: &mut Child, name: &'static str) -> ProcessError {
    let _ = child.kill();
    let _ = child.wait();
    ProcessError::MissingPipe(name)
}

#[allow(clippy::too_many_arguments)]
fn run_process_owner(
    mut child: Child,
    mut process_tree: ProcessTree,
    generation: u64,
    state: Arc<Mutex<ProcessSnapshot>>,
    stop_rx: Receiver<StopCommand>,
    writer_tx: SyncSender<WriterCommand>,
    writer_shutdown: Arc<AtomicBool>,
    _writer: JoinHandle<()>,
    _stdout_reader: JoinHandle<()>,
    _stderr_reader: JoinHandle<()>,
    event_tx: SyncSender<ProcessEvent>,
    _dispatcher: JoinHandle<()>,
    dropped_events: Arc<AtomicU64>,
    poll_interval: Duration,
) {
    let mut requested_stop: Option<StopCommand> = None;
    let mut stop_error_sent = false;
    let (status, reason) = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                break (
                    Some(status),
                    if requested_stop.is_some() {
                        ExitReason::Stopped
                    } else {
                        ExitReason::Natural
                    },
                )
            }
            Ok(None) => {}
            Err(error) => {
                update_failure(&state, "process_wait_failed");
                let _ = process_tree.terminate(&mut child);
                emit_best_effort(
                    &event_tx,
                    ProcessEvent::Diagnostic(ProcessDiagnostic {
                        generation,
                        code: "process_wait_failed",
                        stream: None,
                        detail: error.to_string(),
                    }),
                    &dropped_events,
                );
                break (None, ExitReason::CleanupFailed);
            }
        }

        if requested_stop.is_none() {
            if let Ok(stop) = stop_rx.try_recv() {
                if let Ok(mut snapshot) = state.lock() {
                    snapshot.phase = ProcessPhase::Stopping;
                }
                let _ = writer_tx.try_send(WriterCommand::Close);
                if let Err(error) = process_tree.terminate(&mut child) {
                    update_failure(&state, "process_tree_terminate_failed");
                    let _ = stop.reply.try_send(Err(error.clone()));
                    stop_error_sent = true;
                    emit_best_effort(
                        &event_tx,
                        ProcessEvent::Diagnostic(ProcessDiagnostic {
                            generation,
                            code: "process_tree_terminate_failed",
                            stream: None,
                            detail: error,
                        }),
                        &dropped_events,
                    );
                }
                requested_stop = Some(stop);
            }
        }

        if let Some(stop) = &requested_stop {
            if Instant::now() >= stop.deadline {
                update_failure(&state, "process_stop_timeout");
                let _ = stop
                    .reply
                    .try_send(Err("process did not exit before the stop deadline".into()));
                stop_error_sent = true;
                let _ = process_tree.terminate(&mut child);
                break (None, ExitReason::CleanupFailed);
            }
        }
        thread::sleep(poll_interval);
    };

    writer_shutdown.store(true, Ordering::Release);
    let _ = writer_tx.try_send(WriterCommand::Close);
    let code = status.as_ref().and_then(ExitStatus::code);
    let exit = ProcessExit {
        generation,
        code,
        reason,
    };
    if let Ok(mut snapshot) = state.lock() {
        snapshot.phase = if reason == ExitReason::CleanupFailed {
            ProcessPhase::Failed
        } else {
            ProcessPhase::Exited
        };
        snapshot.last_exit = Some(exit.clone());
    }
    emit_best_effort(&event_tx, ProcessEvent::Exit(exit.clone()), &dropped_events);
    if let Ok(mut snapshot) = state.lock() {
        snapshot.dropped_events = dropped_events.load(Ordering::Relaxed);
    }
    if let Some(stop) = requested_stop.filter(|_| !stop_error_sent) {
        let _ = stop.reply.try_send(Ok(exit));
    }
}

fn update_failure(state: &Arc<Mutex<ProcessSnapshot>>, code: &str) {
    if let Ok(mut snapshot) = state.lock() {
        snapshot.phase = ProcessPhase::Failed;
        snapshot.last_error_code = Some(code.to_owned());
    }
}

fn spawn_stdin_writer(
    stdin: ChildStdin,
    commands: Receiver<WriterCommand>,
    shutdown: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("pi-stdin-writer".into())
        .spawn(move || run_stdin_writer(stdin, commands, shutdown))
        .expect("failed to spawn Pi stdin writer")
}

fn run_stdin_writer(
    mut stdin: ChildStdin,
    commands: Receiver<WriterCommand>,
    shutdown: Arc<AtomicBool>,
) {
    while !shutdown.load(Ordering::Acquire) {
        let command = match commands.recv_timeout(Duration::from_millis(50)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match command {
            WriterCommand::Write { bytes, reply } => {
                let result = stdin
                    .write_all(&bytes)
                    .and_then(|_| stdin.flush())
                    .map_err(|error| error.to_string());
                let failed = result.is_err();
                let _ = reply.try_send(result);
                if failed {
                    break;
                }
            }
            WriterCommand::Close => break,
        }
    }
}

fn spawn_event_dispatcher(
    events: Receiver<ProcessEvent>,
    sink: impl Fn(ProcessEvent) + Send + Sync + 'static,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("pi-event-dispatcher".into())
        .spawn(move || {
            for event in events {
                sink(event);
            }
        })
        .expect("failed to spawn Pi event dispatcher")
}

fn spawn_pipe_reader<R: Read + Send + 'static>(
    reader: R,
    generation: u64,
    stream: OutputStream,
    max_line_bytes: usize,
    events: SyncSender<ProcessEvent>,
    dropped_events: Arc<AtomicU64>,
) -> JoinHandle<()> {
    let name = match stream {
        OutputStream::Stdout => "pi-stdout-reader",
        OutputStream::Stderr => "pi-stderr-reader",
    };
    thread::Builder::new()
        .name(name.into())
        .spawn(move || {
            let result = read_bounded_lines(
                BufReader::new(reader),
                max_line_bytes,
                |line| {
                    let event = match stream {
                        OutputStream::Stdout => ProcessEvent::Stdout(line),
                        OutputStream::Stderr => ProcessEvent::Stderr(line),
                    };
                    emit_best_effort(&events, event, &dropped_events);
                },
                |error| {
                    emit_best_effort(
                        &events,
                        ProcessEvent::Diagnostic(ProcessDiagnostic {
                            generation,
                            code: error.code,
                            stream: Some(stream),
                            detail: error.detail,
                        }),
                        &dropped_events,
                    );
                },
            );
            if let Err(error) = result {
                emit_best_effort(
                    &events,
                    ProcessEvent::Diagnostic(ProcessDiagnostic {
                        generation,
                        code: error.code,
                        stream: Some(stream),
                        detail: error.detail,
                    }),
                    &dropped_events,
                );
            }
        })
        .expect("failed to spawn Pi pipe reader")
}

fn emit_best_effort(
    events: &SyncSender<ProcessEvent>,
    event: ProcessEvent,
    dropped_events: &AtomicU64,
) {
    match events.try_send(event) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
            dropped_events.fetch_add(1, Ordering::Relaxed);
        }
    }
}

#[derive(Debug)]
struct LineReadError {
    code: &'static str,
    detail: String,
}

fn read_bounded_lines<R: BufRead>(
    mut reader: R,
    max_line_bytes: usize,
    mut on_line: impl FnMut(String),
    mut on_rejected_line: impl FnMut(LineReadError),
) -> Result<(), LineReadError> {
    let mut line = Vec::with_capacity(max_line_bytes.min(8 * 1024));
    let mut oversized = false;
    loop {
        let available = reader.fill_buf().map_err(|error| LineReadError {
            code: "process_output_read_failed",
            detail: error.to_string(),
        })?;
        if available.is_empty() {
            if oversized {
                on_rejected_line(LineReadError {
                    code: "process_output_line_too_large",
                    detail: format!("output line exceeded {max_line_bytes} bytes"),
                });
            }
            if !line.is_empty() {
                if let Err(error) = emit_decoded_line(&mut line, &mut on_line) {
                    on_rejected_line(error);
                }
            }
            return Ok(());
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        let content_len = newline.unwrap_or(take);
        if !oversized {
            if line.len().saturating_add(content_len) > max_line_bytes {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_len]);
            }
        }
        reader.consume(take);

        if newline.is_some() {
            if oversized {
                on_rejected_line(LineReadError {
                    code: "process_output_line_too_large",
                    detail: format!("output line exceeded {max_line_bytes} bytes"),
                });
                oversized = false;
                continue;
            }
            if let Err(error) = emit_decoded_line(&mut line, &mut on_line) {
                on_rejected_line(error);
            }
        }
    }
}

fn emit_decoded_line(
    line: &mut Vec<u8>,
    on_line: &mut impl FnMut(String),
) -> Result<(), LineReadError> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    let decoded = String::from_utf8(std::mem::take(line)).map_err(|error| LineReadError {
        code: "process_output_invalid_utf8",
        detail: error.to_string(),
    })?;
    if !decoded.trim().is_empty() {
        on_line(decoded);
    }
    Ok(())
}

#[cfg(windows)]
fn configure_platform_command(command: &mut Command, create_no_window: bool) {
    if create_no_window {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(not(windows))]
fn configure_platform_command(command: &mut Command, _create_no_window: bool) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
struct ProcessTree {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for ProcessTree {}

#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &mut Child) -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() || job == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error().to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                let error = io::Error::last_os_error().to_string();
                CloseHandle(job);
                return Err(error);
            }
            if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                let error = io::Error::last_os_error().to_string();
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self { job })
        }
    }

    fn terminate(&mut self, child: &mut Child) -> Result<(), String> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let result = unsafe { TerminateJobObject(self.job, 1) };
        if result == 0 {
            child.kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        if !self.job.is_null() {
            unsafe {
                CloseHandle(self.job);
            }
            self.job = std::ptr::null_mut();
        }
    }
}

#[cfg(unix)]
struct ProcessTree {
    process_group: i32,
}

#[cfg(unix)]
impl ProcessTree {
    fn attach(child: &mut Child) -> Result<Self, String> {
        Ok(Self {
            process_group: child.id() as i32,
        })
    }

    fn terminate(&mut self, child: &mut Child) -> Result<(), String> {
        let result = unsafe { libc::killpg(self.process_group, libc::SIGKILL) };
        if result != 0 {
            child.kill().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        unsafe {
            libc::killpg(self.process_group, libc::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn builds_compatible_rpc_command() {
        let mut command = Command::new("pi");
        command.args(["--mode", "rpc", "--session", "session.jsonl"]);
        command.current_dir("project");
        let spec = LaunchSpec::from_command(&command);
        assert_eq!(spec.program, OsString::from("pi"));
        assert_eq!(
            spec.args,
            ["--mode", "rpc", "--session", "session.jsonl"]
                .map(OsString::from)
                .to_vec()
        );
        assert_eq!(spec.cwd, Some(PathBuf::from("project")));
    }

    #[test]
    fn frames_one_bounded_json_line() {
        assert_eq!(
            frame_json_line(r#"{"type":"get_state"}"#, 128).unwrap(),
            b"{\"type\":\"get_state\"}\n"
        );
        assert!(matches!(
            frame_json_line("{}\n{}", 128),
            Err(ProcessError::InvalidJsonLine)
        ));
        assert!(matches!(
            frame_json_line("[]", 128),
            Err(ProcessError::InvalidJsonLine)
        ));
    }

    #[test]
    fn rejects_oversized_input() {
        assert!(matches!(
            frame_json_line(r#"{"message":"too large"}"#, 8),
            Err(ProcessError::InputTooLarge { limit: 8 })
        ));
    }

    #[test]
    fn drains_after_rejecting_oversized_output() {
        let input = b"0123456789\nvalid\n";
        let mut lines = Vec::new();
        let mut errors = Vec::new();
        read_bounded_lines(
            BufReader::new(&input[..]),
            5,
            |line| lines.push(line),
            |error| errors.push(error.code),
        )
        .unwrap();
        assert_eq!(lines, vec!["valid"]);
        assert_eq!(errors, vec!["process_output_line_too_large"]);
    }

    #[test]
    fn natural_exit_is_reported_once() {
        let (events_tx, events_rx) = mpsc::channel();
        let process = PiProcess::spawn(
            7,
            &exit_command(7),
            ProcessLimits::default(),
            move |event| {
                let _ = events_tx.send(event);
            },
        )
        .unwrap();
        let exit = process.wait_for_exit(Duration::from_secs(5)).unwrap();
        assert_eq!(exit.generation, 7);
        assert_eq!(exit.reason, ExitReason::Natural);
        let delivered = loop {
            let event = events_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            if let ProcessEvent::Exit(exit) = event {
                break exit;
            }
        };
        assert_eq!(delivered, exit);
        assert!(!events_rx
            .try_iter()
            .any(|event| matches!(event, ProcessEvent::Exit(_))));
    }

    #[test]
    fn stop_is_idempotent_and_bounded() {
        let process =
            PiProcess::spawn(9, &sleep_command(), ProcessLimits::default(), |_| {}).unwrap();
        let started = Instant::now();
        let first = process.stop(Duration::from_secs(3)).unwrap();
        let second = process.stop(Duration::from_secs(3)).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.reason, ExitReason::Stopped);
        assert!(started.elapsed() < Duration::from_secs(4));
    }

    #[test]
    fn blocked_event_sink_does_not_block_stop() {
        use std::sync::{Condvar, Mutex};

        let entered = Arc::new((Mutex::new(false), Condvar::new()));
        let released = Arc::new((Mutex::new(false), Condvar::new()));
        let entered_for_sink = Arc::clone(&entered);
        let released_for_sink = Arc::clone(&released);
        let process = PiProcess::spawn(
            10,
            &output_sleep_command(),
            ProcessLimits::default(),
            move |event| {
                if matches!(event, ProcessEvent::Stdout(_)) {
                    let (entered_lock, entered_cv) = &*entered_for_sink;
                    *entered_lock.lock().unwrap() = true;
                    entered_cv.notify_one();

                    let (released_lock, released_cv) = &*released_for_sink;
                    let mut released = released_lock.lock().unwrap();
                    while !*released {
                        released = released_cv.wait(released).unwrap();
                    }
                }
            },
        )
        .unwrap();

        let (entered_lock, entered_cv) = &*entered;
        let entered_guard = entered_lock.lock().unwrap();
        let (entered_guard, timeout) = entered_cv
            .wait_timeout_while(entered_guard, Duration::from_secs(5), |value| !*value)
            .unwrap();
        assert!(*entered_guard && !timeout.timed_out());

        let started = Instant::now();
        process.stop(Duration::from_secs(3)).unwrap();
        assert!(started.elapsed() < Duration::from_secs(4));

        let (released_lock, released_cv) = &*released;
        *released_lock.lock().unwrap() = true;
        released_cv.notify_one();
    }

    #[test]
    fn windows_job_closes_descendant_tree() {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };

            let (events_tx, events_rx) = mpsc::channel();
            let process = PiProcess::spawn(
                11,
                &windows_descendant_command(),
                ProcessLimits::default(),
                move |event| {
                    let _ = events_tx.send(event);
                },
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let child_pid = loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let event = events_rx.recv_timeout(remaining).unwrap();
                if let ProcessEvent::Stdout(line) = event {
                    if let Some(pid) = line.strip_prefix("CHILD_PID=") {
                        break pid.parse::<u32>().unwrap();
                    }
                }
            };
            process.stop(Duration::from_secs(3)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                let handle =
                    unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, child_pid) };
                if handle.is_null() {
                    break;
                }
                unsafe { CloseHandle(handle) };
                assert!(
                    Instant::now() < deadline,
                    "descendant process {child_pid} survived"
                );
                thread::sleep(Duration::from_millis(25));
            }
        }
    }

    #[cfg(windows)]
    fn exit_command(code: i32) -> LaunchSpec {
        LaunchSpec::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(format!("exit {code}"))
    }

    #[cfg(unix)]
    fn exit_command(code: i32) -> LaunchSpec {
        LaunchSpec::new("sh").arg("-c").arg(format!("exit {code}"))
    }

    #[cfg(windows)]
    fn sleep_command() -> LaunchSpec {
        LaunchSpec::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg("Start-Sleep -Seconds 30")
    }

    #[cfg(windows)]
    fn output_sleep_command() -> LaunchSpec {
        LaunchSpec::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg("Write-Output ready; Start-Sleep -Seconds 30")
    }

    #[cfg(unix)]
    fn sleep_command() -> LaunchSpec {
        LaunchSpec::new("sh").arg("-c").arg("sleep 30")
    }

    #[cfg(unix)]
    fn output_sleep_command() -> LaunchSpec {
        LaunchSpec::new("sh").arg("-c").arg("echo ready; sleep 30")
    }

    #[cfg(windows)]
    fn windows_descendant_command() -> LaunchSpec {
        LaunchSpec::new("powershell.exe")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg("$p=Start-Process -PassThru -WindowStyle Hidden powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'; Write-Output ('CHILD_PID='+$p.Id); Wait-Process -Id $p.Id")
    }
}
