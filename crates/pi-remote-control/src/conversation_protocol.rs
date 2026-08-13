use crate::protocol::{
    validate_relative_path, RemoteInteractionKind, RemoteInteractionResponseValue, ValidationError,
    MAX_REQUEST_ID_BYTES,
};
use serde::{Deserialize, Serialize};

pub const REMOTE_CONVERSATION_PROTOCOL_VERSION: u8 = 2;
pub const REMOTE_CONVERSATION_MAX_CONTEXT_FILES: usize = 16;
pub const REMOTE_CONVERSATION_MAX_PROMPT_BYTES: usize = 32 * 1024;
pub const REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const REMOTE_CONVERSATION_MAX_DELTA_BYTES: usize = 16 * 1024;
pub const REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES: usize = 8 * 1024;
pub const REMOTE_CONVERSATION_MAX_PAGE_SIZE: usize = 100;
pub const REMOTE_CONVERSATION_MAX_QUEUED_TURNS: u8 = 8;
pub const REMOTE_CONVERSATION_GLOBAL_ACTIVE_TURNS: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationContextFile {
    #[serde(rename = "relativePath")]
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMessageRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMessageStatus {
    Accepted,
    Streaming,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTurnState {
    Queued,
    Starting,
    Running,
    AwaitingInput,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConversationStatus {
    Idle,
    Queued,
    Starting,
    Running,
    AwaitingInput,
    Interrupted,
    Archived,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConversationErrorCode {
    InvalidContext,
    QueueFull,
    SessionResumeUnavailable,
    ProjectUnavailable,
    ProjectRevoked,
    ProcessFailed,
    Timeout,
    Cancelled,
    HostInterrupted,
    EventBackpressure,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationError {
    pub code: RemoteConversationErrorCode,
    pub message: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteMessage {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub role: RemoteMessageRole,
    pub status: RemoteMessageStatus,
    pub text: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        rename = "completedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteConversationError>,
}

impl RemoteMessage {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_required_text("messageId", &self.message_id, MAX_REQUEST_ID_BYTES)?;
        validate_required_text(
            "conversationId",
            &self.conversation_id,
            MAX_REQUEST_ID_BYTES,
        )?;
        validate_required_text("turnId", &self.turn_id, MAX_REQUEST_ID_BYTES)?;
        validate_required_text("createdAt", &self.created_at, 64)?;
        validate_required_text("updatedAt", &self.updated_at, 64)?;
        validate_text_allow_newlines(
            "text",
            &self.text,
            REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES,
        )?;
        if let Some(completed_at) = &self.completed_at {
            validate_required_text("completedAt", completed_at, 64)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteDeliverySnapshot {
    #[serde(rename = "deliveryId")]
    pub delivery_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub status: RemoteTurnDeliveryState,
    #[serde(rename = "acceptedAt")]
    pub accepted_at: String,
    #[serde(
        rename = "deliveredAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub delivered_at: Option<String>,
    #[serde(rename = "failedAt", default, skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteConversationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteTurnDeliveryState {
    Accepted,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnSnapshot {
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "ownerDeviceId")]
    pub owner_device_id: String,
    pub state: RemoteTurnState,
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
    #[serde(rename = "userMessageId")]
    pub user_message_id: String,
    #[serde(
        rename = "assistantMessageId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub assistant_message_id: Option<String>,
    #[serde(
        rename = "pendingInteractionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_interaction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<RemoteDeliverySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteConversationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationInteractionOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteConversationInteractionStatus {
    Pending,
    Resolved,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteInteractionResponseSnapshot {
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    pub kind: RemoteInteractionKind,
    pub value: RemoteInteractionResponseValue,
    #[serde(rename = "submittedAt")]
    pub submitted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationInteractionSnapshot {
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub kind: RemoteInteractionKind,
    pub status: RemoteConversationInteractionStatus,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<RemoteConversationInteractionOption>>,
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
    pub response: Option<RemoteInteractionResponseSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationCapabilities {
    #[serde(rename = "conversationV2")]
    pub conversation_v2: bool,
    #[serde(rename = "piSessionResume")]
    pub pi_session_resume: bool,
    #[serde(rename = "appendTurns")]
    pub append_turns: bool,
    #[serde(rename = "cancelTurn")]
    pub cancel_turn: bool,
    pub interactions: bool,
    #[serde(rename = "messagePaging")]
    pub message_paging: bool,
    #[serde(rename = "eventReplay")]
    pub event_replay: bool,
    #[serde(rename = "maxQueuedTurns")]
    pub max_queued_turns: u8,
    #[serde(rename = "maxPromptBytes")]
    pub max_prompt_bytes: usize,
    #[serde(rename = "maxContextFiles")]
    pub max_context_files: usize,
    #[serde(rename = "maxPageSize")]
    pub max_page_size: usize,
}

impl RemoteConversationCapabilities {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.max_queued_turns != REMOTE_CONVERSATION_MAX_QUEUED_TURNS {
            return Err(ValidationError::InvalidValue {
                field: "maxQueuedTurns",
            });
        }
        if self.max_prompt_bytes != REMOTE_CONVERSATION_MAX_PROMPT_BYTES {
            return Err(ValidationError::InvalidValue {
                field: "maxPromptBytes",
            });
        }
        if self.max_context_files != REMOTE_CONVERSATION_MAX_CONTEXT_FILES {
            return Err(ValidationError::InvalidValue {
                field: "maxContextFiles",
            });
        }
        if self.max_page_size != REMOTE_CONVERSATION_MAX_PAGE_SIZE {
            return Err(ValidationError::InvalidValue {
                field: "maxPageSize",
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationSnapshot {
    pub version: u8,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "ownerDeviceId")]
    pub owner_device_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: RemoteConversationStatus,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        rename = "archivedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub archived_at: Option<String>,
    #[serde(
        rename = "activeTurn",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub active_turn: Option<RemoteTurnSnapshot>,
    #[serde(
        rename = "latestTurn",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_turn: Option<RemoteTurnSnapshot>,
    #[serde(
        rename = "latestMessage",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_message: Option<RemoteMessage>,
    #[serde(
        rename = "pendingInteraction",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_interaction: Option<RemoteConversationInteractionSnapshot>,
    #[serde(rename = "messageCount")]
    pub message_count: u64,
    #[serde(rename = "turnCount")]
    pub turn_count: u64,
    #[serde(rename = "queuedTurnCount")]
    pub queued_turn_count: u64,
    pub capabilities: RemoteConversationCapabilities,
}

impl RemoteConversationSnapshot {
    pub fn validate(&self) -> Result<(), ValidationError> {
        if self.version != REMOTE_CONVERSATION_PROTOCOL_VERSION {
            return Err(ValidationError::InvalidValue { field: "version" });
        }
        self.capabilities.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationSummary {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "ownerDeviceId")]
    pub owner_device_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: RemoteConversationStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    #[serde(
        rename = "latestTurnState",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_turn_state: Option<RemoteTurnState>,
    #[serde(
        rename = "latestMessagePreview",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub latest_message_preview: Option<String>,
    #[serde(
        rename = "pendingInteractionId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub pending_interaction_id: Option<String>,
    #[serde(rename = "queuedTurnCount")]
    pub queued_turn_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationCreateRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub prompt: String,
    #[serde(rename = "contextFiles")]
    pub context_files: Vec<RemoteConversationContextFile>,
}

impl RemoteConversationCreateRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_required_text("requestId", &self.request_id, MAX_REQUEST_ID_BYTES)?;
        validate_required_text("projectId", &self.project_id, MAX_REQUEST_ID_BYTES)?;
        validate_text_allow_newlines("prompt", &self.prompt, REMOTE_CONVERSATION_MAX_PROMPT_BYTES)?;
        validate_context_files(&self.context_files)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationCreateResponse {
    pub conversation: RemoteConversationSnapshot,
    pub turn: RemoteTurnSnapshot,
    #[serde(rename = "userMessage")]
    pub user_message: RemoteMessage,
    pub delivery: RemoteDeliverySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnAppendRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub prompt: String,
    #[serde(
        rename = "contextFiles",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub context_files: Option<Vec<RemoteConversationContextFile>>,
}

impl RemoteTurnAppendRequest {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validate_required_text("requestId", &self.request_id, MAX_REQUEST_ID_BYTES)?;
        validate_text_allow_newlines("prompt", &self.prompt, REMOTE_CONVERSATION_MAX_PROMPT_BYTES)?;
        if let Some(context_files) = &self.context_files {
            validate_context_files(context_files)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnAppendResponse {
    pub conversation: RemoteConversationSnapshot,
    pub turn: RemoteTurnSnapshot,
    #[serde(rename = "userMessage")]
    pub user_message: RemoteMessage,
    pub delivery: RemoteDeliverySnapshot,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnCancelRequest {
    #[serde(rename = "requestId")]
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnCancelResponse {
    pub conversation: RemoteConversationSnapshot,
    pub turn: RemoteTurnSnapshot,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationListResponse {
    pub conversations: Vec<RemoteConversationSummary>,
    #[serde(
        rename = "nextCursor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteMessagePageResponse {
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    pub messages: Vec<RemoteMessage>,
    #[serde(
        rename = "nextCursor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationEventBase {
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(rename = "emittedAt")]
    pub emitted_at: String,
    pub sequence: u64,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum RemoteConversationEvent {
    #[serde(rename = "conversation.created")]
    ConversationCreated(RemoteConversationCreatedEvent),
    #[serde(rename = "conversation.status_changed")]
    ConversationStatusChanged(RemoteConversationStatusChangedEvent),
    #[serde(rename = "turn.created")]
    TurnCreated(RemoteTurnCreatedEvent),
    #[serde(rename = "turn.state_changed")]
    TurnStateChanged(RemoteTurnStateChangedEvent),
    #[serde(rename = "turn.completed")]
    TurnCompleted(RemoteTurnCompletedEvent),
    #[serde(rename = "message.accepted")]
    MessageAccepted(RemoteMessageAcceptedEvent),
    #[serde(rename = "message.delta")]
    MessageDelta(RemoteMessageDeltaEvent),
    #[serde(rename = "message.completed")]
    MessageCompleted(RemoteMessageCompletedEvent),
    #[serde(rename = "tool.started")]
    ToolStarted(RemoteToolStartedEvent),
    #[serde(rename = "tool.completed")]
    ToolCompleted(RemoteToolCompletedEvent),
    #[serde(rename = "interaction.requested")]
    InteractionRequested(RemoteConversationInteractionRequestedEvent),
    #[serde(rename = "interaction.resolved")]
    InteractionResolved(RemoteConversationInteractionResolvedEvent),
    #[serde(rename = "interaction.expired")]
    InteractionExpired(RemoteConversationInteractionExpiredEvent),
    #[serde(rename = "snapshot_required")]
    SnapshotRequired(RemoteConversationSnapshotRequiredEvent),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationCreatedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    pub conversation: RemoteConversationSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationStatusChangedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    pub from: RemoteConversationStatus,
    pub to: RemoteConversationStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnCreatedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    pub turn: RemoteTurnSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnStateChangedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub from: RemoteTurnState,
    pub to: RemoteTurnState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteConversationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteTurnCompletedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub state: RemoteTurnTerminalState,
    #[serde(
        rename = "assistantMessageId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub assistant_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RemoteConversationError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteMessageAcceptedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    pub message: RemoteMessage,
    pub delivery: RemoteDeliverySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteMessageDeltaEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "messageId")]
    pub message_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteMessageCompletedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    pub message: RemoteMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteToolStartedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteToolCompletedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(rename = "isError")]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationInteractionRequestedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    #[serde(rename = "interactionKind")]
    pub interaction_kind: RemoteInteractionKind,
    pub prompt: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationInteractionResolvedEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
    pub response: RemoteInteractionResponseSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationInteractionExpiredEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "interactionId")]
    pub interaction_id: String,
    #[serde(rename = "turnId")]
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RemoteConversationSnapshotRequiredEvent {
    #[serde(flatten)]
    pub base: RemoteConversationEventBase,
    #[serde(rename = "projectId", default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub reason: RemoteConversationSnapshotRequiredReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTurnTerminalState {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RemoteConversationSnapshotRequiredReason {
    CursorExpired,
    RetentionExceeded,
    GapDetected,
    Backpressure,
}

pub fn is_remote_turn_terminal_state(state: &RemoteTurnState) -> bool {
    matches!(
        state,
        RemoteTurnState::Succeeded | RemoteTurnState::Failed | RemoteTurnState::Cancelled
    )
}

pub fn can_transition_remote_turn(from: &RemoteTurnState, to: &RemoteTurnState) -> bool {
    match from {
        RemoteTurnState::Queued => matches!(
            to,
            RemoteTurnState::Starting | RemoteTurnState::Cancelled | RemoteTurnState::Failed
        ),
        RemoteTurnState::Starting => matches!(
            to,
            RemoteTurnState::Running | RemoteTurnState::Cancelled | RemoteTurnState::Failed
        ),
        RemoteTurnState::Running => matches!(
            to,
            RemoteTurnState::AwaitingInput
                | RemoteTurnState::Succeeded
                | RemoteTurnState::Failed
                | RemoteTurnState::Cancelled
        ),
        RemoteTurnState::AwaitingInput => matches!(
            to,
            RemoteTurnState::Running | RemoteTurnState::Cancelled | RemoteTurnState::Failed
        ),
        RemoteTurnState::Succeeded | RemoteTurnState::Failed | RemoteTurnState::Cancelled => false,
    }
}

pub fn derive_remote_conversation_status(
    archived_at: Option<&str>,
    active_turn: Option<&RemoteTurnSnapshot>,
    latest_turn: Option<&RemoteTurnSnapshot>,
) -> RemoteConversationStatus {
    if archived_at.is_some() {
        return RemoteConversationStatus::Archived;
    }
    let Some(turn) = active_turn.or(latest_turn) else {
        return RemoteConversationStatus::Idle;
    };
    match turn.state {
        RemoteTurnState::Queued => RemoteConversationStatus::Queued,
        RemoteTurnState::Starting => RemoteConversationStatus::Starting,
        RemoteTurnState::Running => RemoteConversationStatus::Running,
        RemoteTurnState::AwaitingInput => RemoteConversationStatus::AwaitingInput,
        RemoteTurnState::Failed
            if turn.error.as_ref().map_or(false, |error| {
                error.code == RemoteConversationErrorCode::HostInterrupted
            }) =>
        {
            RemoteConversationStatus::Interrupted
        }
        RemoteTurnState::Succeeded | RemoteTurnState::Failed | RemoteTurnState::Cancelled => {
            RemoteConversationStatus::Idle
        }
    }
}

pub fn derive_remote_conversation_status_with_availability(
    archived_at: Option<&str>,
    available: bool,
    active_turn: Option<&RemoteTurnSnapshot>,
    latest_turn: Option<&RemoteTurnSnapshot>,
) -> RemoteConversationStatus {
    if archived_at.is_some() {
        return RemoteConversationStatus::Archived;
    }
    if !available {
        return RemoteConversationStatus::Unavailable;
    }
    derive_remote_conversation_status(archived_at, active_turn, latest_turn)
}

pub fn event_base(event: &RemoteConversationEvent) -> &RemoteConversationEventBase {
    match event {
        RemoteConversationEvent::ConversationCreated(event) => &event.base,
        RemoteConversationEvent::ConversationStatusChanged(event) => &event.base,
        RemoteConversationEvent::TurnCreated(event) => &event.base,
        RemoteConversationEvent::TurnStateChanged(event) => &event.base,
        RemoteConversationEvent::TurnCompleted(event) => &event.base,
        RemoteConversationEvent::MessageAccepted(event) => &event.base,
        RemoteConversationEvent::MessageDelta(event) => &event.base,
        RemoteConversationEvent::MessageCompleted(event) => &event.base,
        RemoteConversationEvent::ToolStarted(event) => &event.base,
        RemoteConversationEvent::ToolCompleted(event) => &event.base,
        RemoteConversationEvent::InteractionRequested(event) => &event.base,
        RemoteConversationEvent::InteractionResolved(event) => &event.base,
        RemoteConversationEvent::InteractionExpired(event) => &event.base,
        RemoteConversationEvent::SnapshotRequired(event) => &event.base,
    }
}

pub fn validate_event_bounds(event: &RemoteConversationEvent) -> Result<(), ValidationError> {
    match event {
        RemoteConversationEvent::MessageDelta(event) => {
            validate_text_allow_newlines("delta", &event.delta, REMOTE_CONVERSATION_MAX_DELTA_BYTES)
        }
        RemoteConversationEvent::ToolStarted(event) => {
            if let Some(summary) = &event.summary {
                validate_text_allow_newlines(
                    "summary",
                    summary,
                    REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES,
                )?;
            }
            Ok(())
        }
        RemoteConversationEvent::ToolCompleted(event) => {
            if let Some(summary) = &event.summary {
                validate_text_allow_newlines(
                    "summary",
                    summary,
                    REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES,
                )?;
            }
            Ok(())
        }
        RemoteConversationEvent::MessageAccepted(event) => event.message.validate(),
        RemoteConversationEvent::MessageCompleted(event) => event.message.validate(),
        RemoteConversationEvent::ConversationCreated(event) => event.conversation.validate(),
        _ => Ok(()),
    }
}

fn validate_context_files(
    context_files: &[RemoteConversationContextFile],
) -> Result<(), ValidationError> {
    if context_files.len() > REMOTE_CONVERSATION_MAX_CONTEXT_FILES {
        return Err(ValidationError::TooMany {
            field: "contextFiles",
            max: REMOTE_CONVERSATION_MAX_CONTEXT_FILES,
        });
    }
    for file in context_files {
        validate_relative_path(&file.relative_path)?;
    }
    Ok(())
}

fn validate_required_text(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> Result<(), ValidationError> {
    if value.is_empty() {
        return Err(ValidationError::Empty { field });
    }
    validate_text_allow_newlines(field, value, max_bytes)
}

fn validate_text_allow_newlines(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> Result<(), ValidationError> {
    if value.len() > max_bytes {
        return Err(ValidationError::TooLong { field, max_bytes });
    }
    if value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(ValidationError::InvalidValue { field });
    }
    Ok(())
}
