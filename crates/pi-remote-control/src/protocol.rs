use serde::{Deserialize, Serialize};
use std::fmt;

pub const MAX_PROMPT_BYTES: usize = 16 * 1024;
pub const MAX_CONTEXT_FILES: usize = 32;
pub const MAX_RELATIVE_PATH_BYTES: usize = 512;
pub const MAX_REQUEST_ID_BYTES: usize = 128;
pub const MAX_DEVICE_ID_BYTES: usize = 128;
pub const MAX_INTERACTION_PROMPT_BYTES: usize = 16 * 1024;
pub const MAX_INTERACTION_OPTIONS: usize = 32;
pub const MAX_INTERACTION_VALUE_BYTES: usize = 16 * 1024;
pub const MAX_EVENT_FRAGMENT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    Empty {
        field: &'static str,
    },
    TooLong {
        field: &'static str,
        max_bytes: usize,
    },
    TooMany {
        field: &'static str,
        max: usize,
    },
    InvalidValue {
        field: &'static str,
    },
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty { field } => write!(f, "{field} must not be empty"),
            Self::TooLong { field, max_bytes } => {
                write!(f, "{field} exceeds {max_bytes} bytes")
            }
            Self::TooMany { field, max } => write!(f, "{field} exceeds {max} entries"),
            Self::InvalidValue { field } => write!(f, "{field} has an invalid value"),
        }
    }
}

impl std::error::Error for ValidationError {}

fn validate_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    if value.len() > max_bytes {
        return Err(ValidationError::TooLong { field, max_bytes });
    }
    if value.chars().any(char::is_control) {
        return Err(ValidationError::InvalidValue { field });
    }
    Ok(())
}

pub fn validate_relative_path(value: &str) -> Result<(), ValidationError> {
    validate_text("relativePath", value, MAX_RELATIVE_PATH_BYTES)?;
    let is_drive_path = value.as_bytes().get(1) == Some(&b':');
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\\')
        || value.contains(':')
        || is_drive_path
        || value.contains('\0')
        || value.split('/').any(|part| {
            part == "." || part == ".." || part.is_empty() || is_reserved_path_component(part)
        })
    {
        return Err(ValidationError::InvalidValue {
            field: "relativePath",
        });
    }
    Ok(())
}

fn is_reserved_path_component(value: &str) -> bool {
    if value.ends_with('.') || value.ends_with(' ') {
        return true;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteEndpoint {
    pub scheme: RemoteEndpointScheme,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteEndpointScheme {
    Https,
    Wss,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingDesktopIdentity {
    #[serde(rename = "desktopId")]
    pub desktop_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CertificatePin {
    pub algorithm: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeOnLanTarget {
    #[serde(rename = "macAddress")]
    pub mac_address: String,
    #[serde(rename = "broadcastAddress")]
    pub broadcast_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WakeOnLanConfig {
    pub targets: Vec<WakeOnLanTarget>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingQrPayload {
    pub protocol: String,
    pub version: u8,
    pub desktop: PairingDesktopIdentity,
    pub endpoints: Vec<RemoteEndpoint>,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    pub secret: String,
    #[serde(rename = "certificatePin")]
    pub certificate_pin: CertificatePin,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

impl fmt::Debug for PairingQrPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingQrPayload")
            .field("protocol", &self.protocol)
            .field("version", &self.version)
            .field("desktop", &self.desktop)
            .field("endpoints", &self.endpoints)
            .field("pairing_id", &self.pairing_id)
            .field("secret", &"<redacted>")
            .field("certificate_pin", &self.certificate_pin)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PairingDevicePlatform {
    Ios,
    Android,
    Desktop,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingDeviceMetadata {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub platform: PairingDevicePlatform,
    #[serde(
        rename = "appVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub app_version: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingRequest {
    pub version: u8,
    #[serde(rename = "pairingId")]
    pub pairing_id: String,
    pub secret: String,
    pub device: PairingDeviceMetadata,
}

impl fmt::Debug for PairingRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingRequest")
            .field("version", &self.version)
            .field("pairing_id", &self.pairing_id)
            .field("secret", &"<redacted>")
            .field("device", &self.device)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingSuccess {
    pub version: u8,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub token: String,
    #[serde(rename = "serverTime")]
    pub server_time: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "wakeOnLan")]
    pub wake_on_lan: Option<WakeOnLanConfig>,
}

impl fmt::Debug for PairingSuccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingSuccess")
            .field("version", &self.version)
            .field("device_id", &self.device_id)
            .field("token", &"<redacted>")
            .field("server_time", &self.server_time)
            .field("wake_on_lan", &self.wake_on_lan)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairingFailureCode {
    InvalidTicket,
    RateLimited,
    IdentityUnavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PairingFailure {
    pub version: u8,
    pub error: PairingFailureCode,
    #[serde(
        rename = "retryAfterMs",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteProjectSummary {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub name: String,
    #[serde(
        rename = "lastOpenedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_opened_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTreeEntryKind {
    Directory,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTreeEntry {
    pub name: String,
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub kind: RemoteTreeEntryKind,
    #[serde(rename = "sizeBytes", default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(
        rename = "modifiedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTreePage {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub directory: String,
    pub entries: Vec<RemoteTreeEntry>,
    #[serde(
        rename = "nextCursor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<String>,
}

/// Read-only text preview of one project file (design §4 extension:
/// `fileBodyAvailable`). Capped at `MAX_FILE_BODY_BYTES`, UTF-8 text only —
/// binary content is rejected, oversized files come back truncated.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteFileBody {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
    pub content: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteProjectCapabilities {
    #[serde(rename = "maxTreeEntriesPerPage")]
    pub max_tree_entries_per_page: u16,
    #[serde(rename = "maxContextFiles")]
    pub max_context_files: u8,
    #[serde(rename = "maxRelativePathBytes")]
    pub max_relative_path_bytes: u16,
    #[serde(rename = "fileBodyAvailable")]
    pub file_body_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTaskContextFile {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTaskExecutionProfile {
    Default,
    Extended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTaskCreateRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub prompt: String,
    #[serde(rename = "contextFiles")]
    pub context_files: Vec<RemoteTaskContextFile>,
    #[serde(
        rename = "executionProfile",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub execution_profile: Option<RemoteTaskExecutionProfile>,
}

impl RemoteTaskCreateRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_text("requestId", &self.request_id, MAX_REQUEST_ID_BYTES)?;
        validate_text("projectId", &self.project_id, MAX_DEVICE_ID_BYTES)?;
        validate_text("prompt", &self.prompt, MAX_PROMPT_BYTES)?;
        if self.context_files.len() > MAX_CONTEXT_FILES {
            return Err(ValidationError::TooMany {
                field: "contextFiles",
                max: MAX_CONTEXT_FILES,
            });
        }
        for file in &self.context_files {
            validate_relative_path(&file.relative_path)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTaskState {
    Queued,
    Starting,
    Running,
    AwaitingInput,
    Succeeded,
    Failed,
    Cancelled,
}

pub fn can_transition_remote_task(from: &RemoteTaskState, to: &RemoteTaskState) -> bool {
    match from {
        RemoteTaskState::Queued => matches!(
            to,
            RemoteTaskState::Starting | RemoteTaskState::Cancelled | RemoteTaskState::Failed
        ),
        RemoteTaskState::Starting => matches!(
            to,
            RemoteTaskState::Running | RemoteTaskState::Cancelled | RemoteTaskState::Failed
        ),
        RemoteTaskState::Running => matches!(
            to,
            RemoteTaskState::AwaitingInput
                | RemoteTaskState::Succeeded
                | RemoteTaskState::Failed
                | RemoteTaskState::Cancelled
        ),
        RemoteTaskState::AwaitingInput => matches!(
            to,
            RemoteTaskState::Running | RemoteTaskState::Cancelled | RemoteTaskState::Failed
        ),
        RemoteTaskState::Succeeded | RemoteTaskState::Failed | RemoteTaskState::Cancelled => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTaskFailureCode {
    AuthenticationFailed,
    ProjectUnavailable,
    ProjectRevoked,
    InvalidContext,
    QueueFull,
    ProcessFailed,
    Timeout,
    Cancelled,
    DesktopRestarted,
    EventBackpressure,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTaskError {
    pub code: RemoteTaskFailureCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteTaskSnapshot {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "ownerDeviceId")]
    pub owner_device_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub state: RemoteTaskState,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(rename = "startedAt", default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(
        rename = "finishedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub finished_at: Option<String>,
    #[serde(rename = "contextFiles")]
    pub context_files: Vec<RemoteTaskContextFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteTaskError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteInteractionKind {
    Confirm,
    Select,
    Input,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInteractionOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInteractionRequest {
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub kind: RemoteInteractionKind,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<RemoteInteractionOption>>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

impl RemoteInteractionRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_text("interactionId", &self.interaction_id, MAX_REQUEST_ID_BYTES)?;
        validate_text("taskId", &self.task_id, MAX_REQUEST_ID_BYTES)?;
        validate_text("prompt", &self.prompt, MAX_INTERACTION_PROMPT_BYTES)?;
        validate_text("createdAt", &self.created_at, 64)?;
        validate_text("expiresAt", &self.expires_at, 64)?;
        if let Some(options) = &self.options {
            if options.len() > MAX_INTERACTION_OPTIONS {
                return Err(ValidationError::TooMany {
                    field: "options",
                    max: MAX_INTERACTION_OPTIONS,
                });
            }
            for option in options {
                validate_text("option.label", &option.label, 512)?;
                validate_text("option.value", &option.value, 512)?;
            }
        }
        match self.kind {
            RemoteInteractionKind::Confirm if self.options.is_some() => {
                Err(ValidationError::InvalidValue { field: "options" })
            }
            RemoteInteractionKind::Select if self.options.as_ref().map_or(true, Vec::is_empty) => {
                Err(ValidationError::InvalidValue { field: "options" })
            }
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RemoteInteractionResponseValue {
    Boolean(bool),
    Text(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInteractionResponse {
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    pub kind: RemoteInteractionKind,
    pub value: RemoteInteractionResponseValue,
    #[serde(rename = "submittedAt")]
    pub submitted_at: String,
}

impl RemoteInteractionResponse {
    pub fn validate(
        &self,
        options: Option<&[RemoteInteractionOption]>,
    ) -> Result<(), ValidationError> {
        validate_text("interactionId", &self.interaction_id, MAX_REQUEST_ID_BYTES)?;
        validate_text("submittedAt", &self.submitted_at, 64)?;
        match (&self.kind, &self.value) {
            (RemoteInteractionKind::Confirm, RemoteInteractionResponseValue::Boolean(_)) => Ok(()),
            (RemoteInteractionKind::Select, RemoteInteractionResponseValue::Text(value)) => {
                validate_text("value", value, MAX_INTERACTION_VALUE_BYTES)?;
                if options.map_or(false, |items| {
                    !items.iter().any(|item| item.value == *value)
                }) {
                    return Err(ValidationError::InvalidValue { field: "value" });
                }
                Ok(())
            }
            (RemoteInteractionKind::Input, RemoteInteractionResponseValue::Text(value)) => {
                validate_text("value", value, MAX_INTERACTION_VALUE_BYTES)
            }
            _ => Err(ValidationError::InvalidValue { field: "value" }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteInteractionStatus {
    Pending,
    Resolved,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteInteractionSnapshot {
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub kind: RemoteInteractionKind,
    pub status: RemoteInteractionStatus,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<RemoteInteractionOption>>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(
        rename = "resolvedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response: Option<RemoteInteractionResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteEventBase {
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "emittedAt")]
    pub emitted_at: String,
    pub sequence: u64,
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum RemoteEvent {
    #[serde(rename = "task.created")]
    TaskCreated {
        #[serde(flatten)]
        base: RemoteEventBase,
        task: RemoteTaskSnapshot,
    },
    #[serde(rename = "task.state_changed")]
    TaskStateChanged {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "taskId")]
        task_id: String,
        from: RemoteTaskState,
        to: RemoteTaskState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteTaskError>,
    },
    #[serde(rename = "task.output_appended")]
    TaskOutputAppended {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "taskId")]
        task_id: String,
        fragment: String,
        stream: String,
    },
    #[serde(rename = "task.completed")]
    TaskCompleted {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "taskId")]
        task_id: String,
        state: RemoteTaskTerminalState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<RemoteTaskError>,
    },
    #[serde(rename = "task.changes")]
    TaskChanges {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "taskId")]
        task_id: String,
        revision: u64,
    },
    #[serde(rename = "interaction.requested")]
    InteractionRequested {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "interactionKind")]
        interaction_kind: RemoteInteractionKind,
        prompt: String,
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    #[serde(rename = "interaction.resolved")]
    InteractionResolved {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
        response: RemoteInteractionResponse,
    },
    #[serde(rename = "interaction.expired")]
    InteractionExpired {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "interactionId")]
        interaction_id: String,
        #[serde(rename = "taskId")]
        task_id: String,
    },
    #[serde(rename = "snapshot_required")]
    SnapshotRequired {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "projectId", default, skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
    },
    #[serde(rename = "event_backpressure")]
    EventBackpressure {
        #[serde(flatten)]
        base: RemoteEventBase,
        #[serde(rename = "taskId")]
        task_id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTaskTerminalState {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyFixtureManifest {
    pub schema: String,
    pub cases: Vec<PolicyFixtureCase>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PolicyFixtureCase {
    pub name: String,
    pub dto: String,
    pub violation: String,
    pub sample: String,
}
