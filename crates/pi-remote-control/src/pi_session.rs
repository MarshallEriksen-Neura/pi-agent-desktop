//! Probe-gated private Pi session adapter for future conversation runtimes.
//!
//! The adapter owns Pi launch flags and private session validation. It is not
//! wired into v1 task execution.

use crate::conversation_protocol::REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES;
use crate::protocol::MAX_PROMPT_BYTES;
use pi_backend_core::pi_process::{LaunchSpec, PiProcess, ProcessEvent, ProcessLimits};
use serde::Deserialize;
use serde_json::Value;
use std::ffi::OsString;
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SESSION_FORMAT_FINGERPRINT: &str = "pi-session-jsonl-v3:type,id,cwd";
const DEFAULT_STOP_TIMEOUT: Duration = Duration::from_secs(5);
// A cold npm-installed Pi start on Windows can legitimately spend several
// seconds loading the runtime and local settings before RPC is ready. Keep the
// compatibility gate bounded, but do not misclassify a healthy cold start.
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(20);
// One bounded execution turn. Mirrors the v1 execution deadline; a warm
// session cannot bypass it.
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub struct PiSessionConfig {
    pub program: OsString,
    pub prefix_args: Vec<OsString>,
    pub session_root: PathBuf,
    pub process_limits: ProcessLimits,
    pub stop_timeout: Duration,
    pub rpc_timeout: Duration,
    pub turn_timeout: Duration,
}

impl fmt::Debug for PiSessionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PiSessionConfig")
            .field("program", &"<redacted>")
            .field("prefix_args", &"<redacted>")
            .field("session_root", &"<redacted>")
            .field("process_limits", &self.process_limits)
            .field("stop_timeout", &self.stop_timeout)
            .field("rpc_timeout", &self.rpc_timeout)
            .finish()
    }
}

impl PiSessionConfig {
    pub fn new(program: impl Into<OsString>, session_root: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            prefix_args: Vec::new(),
            session_root: session_root.into(),
            process_limits: ProcessLimits::default(),
            stop_timeout: DEFAULT_STOP_TIMEOUT,
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
            turn_timeout: DEFAULT_TURN_TIMEOUT,
        }
    }

    pub fn with_prefix_args(mut self, args: impl IntoIterator<Item = impl Into<OsString>>) -> Self {
        self.prefix_args = args.into_iter().map(Into::into).collect();
        self
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PiSessionContext {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub project_id: String,
    pub project_root: PathBuf,
}

impl fmt::Debug for PiSessionContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PiSessionContext")
            .field("owner_device_id", &self.owner_device_id)
            .field("conversation_id", &self.conversation_id)
            .field("project_id", &self.project_id)
            .field("project_root", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PiSessionProbe {
    pub pi_version: String,
    pub format_fingerprint: String,
}

/// Result of one bounded turn executed through [`PiSessionHandle::run_turn`].
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PiTurnOutcome {
    pub assistant_text: String,
    pub agent_end: bool,
    pub interaction_requested: bool,
}

#[derive(Clone, Eq, PartialEq)]
pub struct PiSessionBinding {
    relative_ref: String,
    session_id: String,
    owner_device_id: String,
    conversation_id: String,
    project_id: String,
    pi_version: String,
    format_fingerprint: String,
}

impl fmt::Debug for PiSessionBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PiSessionBinding")
            .field("relative_ref", &"<redacted>")
            .field("session_id", &"<redacted>")
            .field("owner_device_id", &self.owner_device_id)
            .field("conversation_id", &self.conversation_id)
            .field("project_id", &self.project_id)
            .field("pi_version", &self.pi_version)
            .field("format_fingerprint", &self.format_fingerprint)
            .finish()
    }
}

impl PiSessionBinding {
    /// Rebuilds a binding from gateway-private storage rows. All fields are
    /// revalidated against the live context and session material by `resume`.
    pub(crate) fn from_storage(
        relative_ref: String,
        session_id: String,
        owner_device_id: String,
        conversation_id: String,
        project_id: String,
        pi_version: String,
        format_fingerprint: String,
    ) -> Self {
        Self {
            relative_ref,
            session_id,
            owner_device_id,
            conversation_id,
            project_id,
            pi_version,
            format_fingerprint,
        }
    }

    pub fn relative_ref_for_storage(&self) -> &str {
        &self.relative_ref
    }

    pub fn session_id_for_storage(&self) -> &str {
        &self.session_id
    }

    #[doc(hidden)]
    pub fn test_mutate_relative_ref(&mut self, relative_ref: impl Into<String>) {
        self.relative_ref = relative_ref.into();
    }

    #[doc(hidden)]
    pub fn test_mutate_owner(&mut self, owner_device_id: impl Into<String>) {
        self.owner_device_id = owner_device_id.into();
    }

    #[doc(hidden)]
    pub fn test_mutate_version(&mut self, pi_version: impl Into<String>) {
        self.pi_version = pi_version.into();
    }

    #[doc(hidden)]
    pub fn test_mutate_format(&mut self, format_fingerprint: impl Into<String>) {
        self.format_fingerprint = format_fingerprint.into();
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PiSessionState {
    pub binding: PiSessionBinding,
}

impl fmt::Debug for PiSessionState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PiSessionState")
            .field("binding", &self.binding)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PiSessionErrorCode {
    InvalidContext,
    ProbeUnavailable,
    SpawnFailed,
    RpcUnavailable,
    SessionUnavailable,
    SessionRejected,
    SessionResumeUnavailable,
    StopTimeout,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PiSessionError {
    code: PiSessionErrorCode,
}

impl PiSessionError {
    pub fn code(&self) -> &PiSessionErrorCode {
        &self.code
    }
}

impl fmt::Display for PiSessionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.code {
            PiSessionErrorCode::InvalidContext => "pi_session_invalid_context",
            PiSessionErrorCode::ProbeUnavailable => "pi_session_probe_unavailable",
            PiSessionErrorCode::SpawnFailed => "pi_session_spawn_failed",
            PiSessionErrorCode::RpcUnavailable => "pi_session_rpc_unavailable",
            PiSessionErrorCode::SessionUnavailable => "pi_session_unavailable",
            PiSessionErrorCode::SessionRejected => "pi_session_rejected",
            PiSessionErrorCode::SessionResumeUnavailable => "session_resume_unavailable",
            PiSessionErrorCode::StopTimeout => "pi_session_stop_timeout",
        })
    }
}

impl std::error::Error for PiSessionError {}

pub struct PiSessionAdapter {
    config: PiSessionConfig,
    probe: PiSessionProbe,
}

impl PiSessionAdapter {
    pub fn probe(
        config: PiSessionConfig,
        context: PiSessionContext,
    ) -> Result<PiSessionProbe, PiSessionError> {
        validate_context(&context)?;
        let root = ensure_session_root(&config)?;
        let pi_version = probe_version(&config)?;
        probe_canary_resume(&config, &context, &root)?;
        Ok(PiSessionProbe {
            pi_version,
            format_fingerprint: SESSION_FORMAT_FINGERPRINT.to_owned(),
        })
    }

    pub fn new(config: PiSessionConfig, probe: PiSessionProbe) -> Result<Self, PiSessionError> {
        if probe.pi_version.is_empty()
            || probe.format_fingerprint != SESSION_FORMAT_FINGERPRINT
            || config.program.is_empty()
        {
            return Err(err(PiSessionErrorCode::ProbeUnavailable));
        }
        Ok(Self { config, probe })
    }

    /// Deletes one gateway-private conversation directory after the runtime
    /// has stopped its child. The context is revalidated before removal so a
    /// caller cannot redirect cleanup outside the app-owned session root.
    pub fn remove_conversation_session(
        &self,
        context: &PiSessionContext,
    ) -> Result<(), PiSessionError> {
        validate_context(context)?;
        let session_dir = conversation_dir(&self.config, context)?;
        if session_dir.exists() {
            fs::remove_dir_all(&session_dir)
                .map_err(|_| err(PiSessionErrorCode::SessionUnavailable))?;
        }
        Ok(())
    }

    pub(crate) fn probe_info(&self) -> &PiSessionProbe {
        &self.probe
    }

    pub fn start(&self, context: PiSessionContext) -> Result<PiSessionHandle, PiSessionError> {
        validate_context(&context)?;
        let session_dir = conversation_dir(&self.config, &context)?;
        fs::create_dir_all(&session_dir).map_err(|_| err(PiSessionErrorCode::InvalidContext))?;
        let mut child = PiSessionChild::spawn(
            build_new_launch(&self.config, &context, &session_dir)?,
            &self.config,
        )
        .map_err(|_| err(PiSessionErrorCode::SpawnFailed))?;
        let raw_state = child.get_state(self.config.rpc_timeout)?;
        validate_reported_session_ref_lexical(&session_dir, raw_state.session_ref()?)?;
        Ok(PiSessionHandle {
            child,
            config: self.config.clone(),
            context,
            pi_version: self.probe.pi_version.clone(),
            state: None,
        })
    }

    pub fn resume(
        &self,
        context: PiSessionContext,
        binding: &PiSessionBinding,
    ) -> Result<PiSessionHandle, PiSessionError> {
        let result = self.resume_inner(context.clone(), binding);
        result.map_err(|error| match error.code {
            PiSessionErrorCode::InvalidContext => error,
            _ => err(PiSessionErrorCode::SessionResumeUnavailable),
        })
    }

    fn resume_inner(
        &self,
        context: PiSessionContext,
        binding: &PiSessionBinding,
    ) -> Result<PiSessionHandle, PiSessionError> {
        validate_context(&context)?;
        validate_binding_matches_context(&self.probe, &context, binding)?;
        let session_file = validated_session_path(&self.config, &context, binding)?;
        validate_session_header(&context, binding, &session_file)?;
        let session_dir = conversation_dir(&self.config, &context)?;
        let mut child = PiSessionChild::spawn(
            build_resume_launch(&self.config, &context, &session_dir, &session_file)?,
            &self.config,
        )
        .map_err(|_| err(PiSessionErrorCode::SpawnFailed))?;
        let state = validate_existing_raw_state(
            &self.config,
            &context,
            &child.get_state(self.config.rpc_timeout)?,
            &self.probe.pi_version,
        )?;
        if &state.binding != binding {
            let _ = child.stop(self.config.stop_timeout);
            return Err(err(PiSessionErrorCode::SessionRejected));
        }
        Ok(PiSessionHandle {
            child,
            config: self.config.clone(),
            context,
            pi_version: self.probe.pi_version.clone(),
            state: Some(state),
        })
    }
}

pub struct PiSessionHandle {
    child: PiSessionChild,
    config: PiSessionConfig,
    context: PiSessionContext,
    pi_version: String,
    state: Option<PiSessionState>,
}

impl fmt::Debug for PiSessionHandle {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PiSessionHandle")
            .field("state", &self.state)
            .field("child", &"<redacted>")
            .finish()
    }
}

impl PiSessionHandle {
    pub fn state(&self) -> Option<&PiSessionState> {
        self.state.as_ref()
    }

    /// Exposes the underlying process for cancellation only. Kill/stop is the
    /// sole legitimate use; conversation I/O must go through the handle.
    pub(crate) fn process_handle(&self) -> Arc<PiProcess> {
        Arc::clone(&self.child.process)
    }

    pub fn prompt_and_wait_settled(&mut self, prompt: &str) -> Result<(), PiSessionError> {
        if prompt.is_empty()
            || prompt.len() > MAX_PROMPT_BYTES
            || prompt.chars().any(char::is_control)
        {
            return Err(err(PiSessionErrorCode::RpcUnavailable));
        }
        self.child.prompt_and_wait_settled(prompt)?;
        let raw_state = self.child.get_state(self.config.rpc_timeout)?;
        let state =
            validate_existing_raw_state(&self.config, &self.context, &raw_state, &self.pi_version)?;
        self.state = Some(state);
        Ok(())
    }

    /// Executes one bounded turn: delivers exactly one prompt, classifies the
    /// streamed events, collects the assistant text, and waits until the
    /// agent settles. Session state is revalidated afterwards, identical to
    /// [`Self::prompt_and_wait_settled`].
    pub fn run_turn(&mut self, prompt: &str) -> Result<PiTurnOutcome, PiSessionError> {
        if prompt.is_empty()
            || prompt.len() > MAX_PROMPT_BYTES
            || prompt.chars().any(char::is_control)
        {
            return Err(err(PiSessionErrorCode::RpcUnavailable));
        }
        let line = serde_json::to_string(&serde_json::json!({
            "type": "prompt",
            "message": prompt,
        }))
        .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        self.child
            .process
            .send_json_line(&line)
            .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        let deadline = Instant::now() + self.config.turn_timeout;
        let mut outcome = PiTurnOutcome::default();
        loop {
            let line = self.child.recv_until(deadline)?;
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("message_update") => {
                    let event = value.get("assistantMessageEvent");
                    let is_text_delta = event
                        .and_then(|event| event.get("type"))
                        .and_then(Value::as_str)
                        == Some("text_delta");
                    if is_text_delta {
                        if let Some(delta) = event
                            .and_then(|event| event.get("delta"))
                            .and_then(Value::as_str)
                        {
                            // Bounded transcript growth: stop accumulating at
                            // the contract message cap instead of growing
                            // without limit.
                            if outcome.assistant_text.len()
                                <= REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES
                            {
                                outcome.assistant_text.push_str(delta);
                            }
                        }
                    }
                }
                Some("agent_end") => outcome.agent_end = true,
                Some("extension_ui_request") => outcome.interaction_requested = true,
                Some("agent_settled") => break,
                _ => {}
            }
        }
        let raw_state = self.child.get_state(self.config.rpc_timeout)?;
        let state =
            validate_existing_raw_state(&self.config, &self.context, &raw_state, &self.pi_version)?;
        self.state = Some(state);
        Ok(outcome)
    }

    pub fn shutdown(mut self) -> Result<(), PiSessionError> {
        self.child.stop(self.config.stop_timeout)
    }
}

impl Drop for PiSessionHandle {
    fn drop(&mut self) {
        let _ = self.child.stop(self.config.stop_timeout);
    }
}

pub struct PiSessionChild {
    process: Arc<PiProcess>,
    events: Receiver<String>,
    stop_timeout: Duration,
    rpc_timeout: Duration,
    next_id: u64,
}

impl PiSessionChild {
    fn spawn(spec: LaunchSpec, config: &PiSessionConfig) -> Result<Self, PiSessionError> {
        let (events_tx, events_rx) = mpsc::sync_channel(256);
        let process = PiProcess::spawn(1, &spec, config.process_limits.clone(), move |event| {
            if let ProcessEvent::Stdout(line) = event {
                let _ = events_tx.try_send(line);
            }
        })
        .map_err(|_| err(PiSessionErrorCode::SpawnFailed))?;
        Ok(Self {
            process: Arc::new(process),
            events: events_rx,
            stop_timeout: config.stop_timeout,
            rpc_timeout: config.rpc_timeout,
            next_id: 1,
        })
    }

    fn get_state(&mut self, timeout: Duration) -> Result<RawPiState, PiSessionError> {
        let id = format!("g001-get-state-{}", self.next_id);
        self.next_id += 1;
        let line = serde_json::to_string(&serde_json::json!({
            "type": "get_state",
            "id": id,
        }))
        .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        self.process
            .send_json_line(&line)
            .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        let deadline = Instant::now() + timeout;
        loop {
            let line = self.recv_until(deadline)?;
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) != Some("response") {
                continue;
            }
            let response_matches_id = value.get("id").and_then(Value::as_str) == Some(id.as_str());
            let response_matches_command =
                value.get("command").and_then(Value::as_str) == Some("get_state");
            if !response_matches_id && !response_matches_command {
                continue;
            }
            if value.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(err(PiSessionErrorCode::RpcUnavailable));
            }
            let Some(data) = value.get("data") else {
                return Err(err(PiSessionErrorCode::RpcUnavailable));
            };
            return serde_json::from_value::<RawPiState>(data.clone())
                .map_err(|_| err(PiSessionErrorCode::RpcUnavailable));
        }
    }

    fn prompt_and_wait_settled(&mut self, prompt: &str) -> Result<(), PiSessionError> {
        let line = serde_json::to_string(&serde_json::json!({
            "type": "prompt",
            "message": prompt,
        }))
        .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        self.process
            .send_json_line(&line)
            .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))?;
        let deadline = Instant::now() + self.rpc_timeout;
        loop {
            let line = self.recv_until(deadline)?;
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(Value::as_str) == Some("agent_settled") {
                return Ok(());
            }
        }
    }

    fn recv_until(&self, deadline: Instant) -> Result<String, PiSessionError> {
        let now = Instant::now();
        if now >= deadline {
            return Err(err(PiSessionErrorCode::RpcUnavailable));
        }
        self.events
            .recv_timeout(deadline - now)
            .map_err(|_| err(PiSessionErrorCode::RpcUnavailable))
    }

    fn stop(&mut self, timeout: Duration) -> Result<(), PiSessionError> {
        self.process
            .stop(if timeout.is_zero() {
                self.stop_timeout
            } else {
                timeout
            })
            .map(|_| ())
            .map_err(|_| err(PiSessionErrorCode::StopTimeout))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPiState {
    session_file: Option<String>,
    session_id: Option<String>,
    session_path: Option<String>,
}

impl RawPiState {
    fn session_ref(&self) -> Result<&str, PiSessionError> {
        self.session_file
            .as_deref()
            .or(self.session_path.as_deref())
            .ok_or_else(|| err(PiSessionErrorCode::SessionUnavailable))
    }

    fn session_id(&self) -> Result<&str, PiSessionError> {
        self.session_id
            .as_deref()
            .ok_or_else(|| err(PiSessionErrorCode::SessionUnavailable))
    }
}

#[derive(Deserialize)]
struct SessionHeader {
    #[serde(rename = "type")]
    record_type: String,
    version: u64,
    id: String,
    cwd: String,
}

fn probe_version(config: &PiSessionConfig) -> Result<String, PiSessionError> {
    let mut command = Command::new(&config.program);
    command.args(&config.prefix_args);
    command.arg("--version");
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))?;
    let deadline = Instant::now() + config.rpc_timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(err(PiSessionErrorCode::ProbeUnavailable));
                }
                let output = child
                    .wait_with_output()
                    .map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))?;
                let version = String::from_utf8(output.stdout)
                    .map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))?
                    .trim()
                    .to_owned();
                return if version.is_empty() {
                    Err(err(PiSessionErrorCode::ProbeUnavailable))
                } else {
                    Ok(version)
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(err(PiSessionErrorCode::ProbeUnavailable));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err(err(PiSessionErrorCode::ProbeUnavailable)),
        }
    }
}

fn probe_canary_resume(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    root: &Path,
) -> Result<(), PiSessionError> {
    let probe_dir = root.join(format!("probe-{}-{}", std::process::id(), now_ms()));
    fs::create_dir_all(&probe_dir).map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))?;
    let canary = probe_dir.join("canary.jsonl");
    let project_root = canonical_dir(&context.project_root)?;
    fs::write(
        &canary,
        format!(
            "{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "g001-canary-session",
                "timestamp": "2026-08-12T00:00:00Z",
                "cwd": project_root,
            })
        ),
    )
    .map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))?;
    let result = (|| {
        let mut child = PiSessionChild::spawn(
            build_probe_resume_launch(config, context, &probe_dir, &canary)?,
            config,
        )?;
        let raw_state = child.get_state(config.rpc_timeout)?;
        validate_reported_session_ref_lexical(&probe_dir, raw_state.session_ref()?)?;
        if raw_state.session_id()? != "g001-canary-session" {
            let _ = child.stop(config.stop_timeout);
            return Err(err(PiSessionErrorCode::ProbeUnavailable));
        }
        let _ = child.stop(config.stop_timeout);
        Ok(())
    })();
    let canonical_probe = fs::canonicalize(&probe_dir).ok();
    if canonical_probe
        .as_ref()
        .is_some_and(|path| path.starts_with(root))
    {
        let _ = fs::remove_dir_all(&probe_dir);
    }
    result.map_err(|_| err(PiSessionErrorCode::ProbeUnavailable))
}

fn build_new_launch(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    session_dir: &Path,
) -> Result<LaunchSpec, PiSessionError> {
    let project_root = canonical_dir(&context.project_root)?;
    let session_id = adapter_session_id(context);
    let mut launch = LaunchSpec::new(config.program.clone()).current_dir(project_root);
    for arg in &config.prefix_args {
        launch = launch.arg(arg.clone());
    }
    Ok(with_safe_rpc_startup_flags(launch)
        .arg("--mode")
        .arg("rpc")
        .arg("--session-dir")
        .arg(session_dir.as_os_str().to_os_string())
        .arg("--session-id")
        .arg(session_id))
}

fn build_resume_launch(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    session_dir: &Path,
    session_file: &Path,
) -> Result<LaunchSpec, PiSessionError> {
    let project_root = canonical_dir(&context.project_root)?;
    let mut launch = LaunchSpec::new(config.program.clone()).current_dir(project_root);
    for arg in &config.prefix_args {
        launch = launch.arg(arg.clone());
    }
    Ok(with_safe_rpc_startup_flags(launch)
        .arg("--mode")
        .arg("rpc")
        .arg("--session-dir")
        .arg(session_dir.as_os_str().to_os_string())
        .arg("--session")
        .arg(session_file.as_os_str().to_os_string()))
}

fn with_safe_rpc_startup_flags(launch: LaunchSpec) -> LaunchSpec {
    launch
        .arg("--offline")
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--no-prompt-templates")
        .arg("--no-context-files")
}

fn build_probe_resume_launch(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    session_dir: &Path,
    session_file: &Path,
) -> Result<LaunchSpec, PiSessionError> {
    let project_root = canonical_dir(&context.project_root)?;
    let mut launch = LaunchSpec::new(config.program.clone()).current_dir(project_root);
    for arg in &config.prefix_args {
        launch = launch.arg(arg.clone());
    }
    Ok(launch
        .arg("--offline")
        .arg("--no-tools")
        .arg("--no-extensions")
        .arg("--no-skills")
        .arg("--no-prompt-templates")
        .arg("--no-context-files")
        .arg("--mode")
        .arg("rpc")
        .arg("--session-dir")
        .arg(session_dir.as_os_str().to_os_string())
        .arg("--session")
        .arg(session_file.as_os_str().to_os_string()))
}

fn validate_context(context: &PiSessionContext) -> Result<(), PiSessionError> {
    for value in [
        &context.owner_device_id,
        &context.conversation_id,
        &context.project_id,
    ] {
        if value.is_empty()
            || value.len() > 128
            || value
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
        {
            return Err(err(PiSessionErrorCode::InvalidContext));
        }
    }
    canonical_dir(&context.project_root).map(|_| ())
}

fn conversation_dir(
    config: &PiSessionConfig,
    context: &PiSessionContext,
) -> Result<PathBuf, PiSessionError> {
    let root = ensure_session_root(config)?;
    Ok(root
        .join(safe_segment(&context.owner_device_id)?)
        .join(safe_segment(&context.project_id)?)
        .join(safe_segment(&context.conversation_id)?))
}

fn ensure_session_root(config: &PiSessionConfig) -> Result<PathBuf, PiSessionError> {
    fs::create_dir_all(&config.session_root)
        .map_err(|_| err(PiSessionErrorCode::InvalidContext))?;
    canonical_dir(&config.session_root)
}

fn safe_segment(value: &str) -> Result<&str, PiSessionError> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        return Err(err(PiSessionErrorCode::InvalidContext));
    }
    Ok(value)
}

fn validate_existing_raw_state(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    raw_state: &RawPiState,
    pi_version: &str,
) -> Result<PiSessionState, PiSessionError> {
    let session_file =
        validate_existing_reported_session_ref(config, context, raw_state.session_ref()?)?;
    let header = read_session_header(&session_file)?;
    validate_header_values(context, raw_state.session_id()?, &header)?;
    let relative_ref = relative_to_root(&ensure_session_root(config)?, &session_file)?;
    Ok(PiSessionState {
        binding: PiSessionBinding {
            relative_ref,
            session_id: raw_state.session_id()?.to_owned(),
            owner_device_id: context.owner_device_id.clone(),
            conversation_id: context.conversation_id.clone(),
            project_id: context.project_id.clone(),
            pi_version: pi_version.to_owned(),
            format_fingerprint: SESSION_FORMAT_FINGERPRINT.to_owned(),
        },
    })
}

fn validate_binding_matches_context(
    probe: &PiSessionProbe,
    context: &PiSessionContext,
    binding: &PiSessionBinding,
) -> Result<(), PiSessionError> {
    if binding.owner_device_id != context.owner_device_id
        || binding.conversation_id != context.conversation_id
        || binding.project_id != context.project_id
        || binding.pi_version != probe.pi_version
        || binding.format_fingerprint != probe.format_fingerprint
        || binding.format_fingerprint != SESSION_FORMAT_FINGERPRINT
    {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    Ok(())
}

fn validate_reported_session_ref_lexical(
    allowed_dir: &Path,
    reported_ref: &str,
) -> Result<PathBuf, PiSessionError> {
    let reported = PathBuf::from(reported_ref);
    if !reported.is_absolute() {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    let allowed =
        fs::canonicalize(allowed_dir).map_err(|_| err(PiSessionErrorCode::InvalidContext))?;
    let parent = reported
        .parent()
        .ok_or_else(|| err(PiSessionErrorCode::SessionRejected))?;
    let canonical_parent =
        fs::canonicalize(parent).map_err(|_| err(PiSessionErrorCode::SessionRejected))?;
    if !canonical_parent.starts_with(&allowed) || path_has_parent_component(&reported) {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    Ok(reported)
}

fn validate_existing_reported_session_ref(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    reported_ref: &str,
) -> Result<PathBuf, PiSessionError> {
    let reported = PathBuf::from(reported_ref);
    if !reported.is_absolute() {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    let root = ensure_session_root(config)?;
    let conversation = conversation_dir(config, context)?;
    let canonical = canonical_file_no_link(&reported)?;
    if !canonical.starts_with(&conversation) || !canonical.starts_with(&root) {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    reject_link_or_reparse_chain(&root, &canonical)?;
    Ok(canonical)
}

fn validated_session_path(
    config: &PiSessionConfig,
    context: &PiSessionContext,
    binding: &PiSessionBinding,
) -> Result<PathBuf, PiSessionError> {
    let root = ensure_session_root(config)?;
    let relative = Path::new(&binding.relative_ref);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    let candidate = root.join(relative);
    let canonical = canonical_file_no_link(&candidate)?;
    if !canonical.starts_with(conversation_dir(config, context)?) || !canonical.starts_with(&root) {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    reject_link_or_reparse_chain(&root, &canonical)?;
    Ok(canonical)
}

fn validate_session_header(
    context: &PiSessionContext,
    binding: &PiSessionBinding,
    session_file: &Path,
) -> Result<(), PiSessionError> {
    let header = read_session_header(session_file)?;
    validate_header_values(context, &binding.session_id, &header)
}

fn read_session_header(session_file: &Path) -> Result<SessionHeader, PiSessionError> {
    let content = fs::read_to_string(session_file)
        .map_err(|_| err(PiSessionErrorCode::SessionUnavailable))?;
    let first = content
        .lines()
        .find(|line| !line.trim().is_empty())
        .ok_or_else(|| err(PiSessionErrorCode::SessionRejected))?;
    serde_json::from_str(first).map_err(|_| err(PiSessionErrorCode::SessionRejected))
}

fn validate_header_values(
    context: &PiSessionContext,
    expected_session_id: &str,
    header: &SessionHeader,
) -> Result<(), PiSessionError> {
    if header.record_type != "session"
        || header.version != 3
        || header.id != expected_session_id
        || expected_session_id.is_empty()
    {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    let header_cwd = canonical_dir(Path::new(&header.cwd))?;
    let project_root = canonical_dir(&context.project_root)?;
    if header_cwd != project_root {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    Ok(())
}

fn relative_to_root(root: &Path, path: &Path) -> Result<String, PiSessionError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| err(PiSessionErrorCode::SessionRejected))?;
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    Ok(relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/"))
}

fn canonical_dir(path: &Path) -> Result<PathBuf, PiSessionError> {
    let canonical = fs::canonicalize(path).map_err(|_| err(PiSessionErrorCode::InvalidContext))?;
    if !canonical.is_dir() {
        return Err(err(PiSessionErrorCode::InvalidContext));
    }
    Ok(canonical)
}

fn canonical_file_no_link(path: &Path) -> Result<PathBuf, PiSessionError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| err(PiSessionErrorCode::SessionUnavailable))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() {
        return Err(err(PiSessionErrorCode::SessionRejected));
    }
    fs::canonicalize(path).map_err(|_| err(PiSessionErrorCode::SessionUnavailable))
}

fn reject_link_or_reparse_chain(root: &Path, path: &Path) -> Result<(), PiSessionError> {
    let mut current = path;
    loop {
        let metadata = fs::symlink_metadata(current)
            .map_err(|_| err(PiSessionErrorCode::SessionUnavailable))?;
        if is_link_or_reparse(&metadata) {
            return Err(err(PiSessionErrorCode::SessionRejected));
        }
        if current == root {
            return Ok(());
        }
        current = current
            .parent()
            .ok_or_else(|| err(PiSessionErrorCode::SessionRejected))?;
    }
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn path_has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn adapter_session_id(context: &PiSessionContext) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in format!(
        "{}:{}:{}:{}",
        context.owner_device_id,
        context.project_id,
        context.conversation_id,
        now_ms()
    )
    .bytes()
    {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (hash >> 32) as u32,
        (hash >> 16) as u16,
        hash as u16 & 0x0fff,
        (hash >> 12) as u16 & 0x0fff,
        hash & 0x0000_ffff_ffff
    )
}

fn err(code: PiSessionErrorCode) -> PiSessionError {
    PiSessionError { code }
}
