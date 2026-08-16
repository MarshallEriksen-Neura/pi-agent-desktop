//! Dedicated remote-control persistence.
//!
//! The gateway never shares the desktop chat database.  Every task snapshot,
//! event and idempotency record that crosses this boundary is committed in a
//! single SQLite transaction so a restart cannot expose an event without its
//! authoritative snapshot (or the reverse).

use crate::conversation_protocol::{
    can_transition_remote_turn, derive_remote_conversation_status, is_remote_turn_terminal_state,
    RemoteConversationCapabilities, RemoteConversationCreateResponse, RemoteConversationError,
    RemoteConversationErrorCode, RemoteConversationEvent, RemoteConversationEventBase,
    RemoteConversationSnapshot, RemoteConversationStatus, RemoteConversationStatusChangedEvent,
    RemoteDeliverySnapshot, RemoteMessage, RemoteMessageCompletedEvent, RemoteMessagePageResponse,
    RemoteMessageRole, RemoteMessageStatus, RemoteTurnAppendResponse, RemoteTurnCompletedEvent,
    RemoteTurnDeliveryState, RemoteTurnSnapshot, RemoteTurnState, RemoteTurnStateChangedEvent,
    RemoteTurnTerminalState, REMOTE_CONVERSATION_MAX_CONTEXT_FILES,
    REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES, REMOTE_CONVERSATION_MAX_PAGE_SIZE,
    REMOTE_CONVERSATION_MAX_PROMPT_BYTES, REMOTE_CONVERSATION_MAX_QUEUED_TURNS,
    REMOTE_CONVERSATION_PROTOCOL_VERSION,
};
use crate::protocol::{
    RemoteEvent, RemoteEventBase, RemoteTaskCreateRequest, RemoteTaskError, RemoteTaskFailureCode,
    RemoteTaskSnapshot, RemoteTaskState, RemoteTaskTerminalState,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const STORAGE_SCHEMA_VERSION: i64 = 4;
pub const MAX_TASKS: usize = 500;
pub const MAX_EVENTS: usize = 10_000;
pub const TASK_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const EVENT_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
pub const MAX_EVENT_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_CONVERSATION_EVENT_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    Corrupt,
    Database,
    PayloadTooLarge,
    InvalidKey,
    IdempotencyConflict,
    UnsupportedSchema(i64),
    DowngradeRefused { found: i64, supported: i64 },
    RestorePoint,
    InvalidTransition,
    QueueFull,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Corrupt => "remote-control storage is corrupt",
            Self::Database => "remote-control storage operation failed",
            Self::PayloadTooLarge => "remote-control storage payload is too large",
            Self::InvalidKey => "remote-control storage key is invalid",
            Self::IdempotencyConflict => "remote-control idempotency key conflicts",
            Self::UnsupportedSchema(_) => "remote-control storage schema is unsupported",
            Self::DowngradeRefused { .. } => {
                "remote-control storage downgrade refused; v2 conversation data is present"
            }
            Self::RestorePoint => "remote-control storage restore point could not be created",
            Self::InvalidTransition => "remote-control turn transition is not allowed",
            Self::QueueFull => "remote-control conversation turn queue is full",
        })
    }
}

impl std::error::Error for StorageError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredEvent {
    pub device_id: String,
    pub sequence: u64,
    pub event_id: String,
    pub emitted_at_ms: u64,
    pub payload: RemoteEvent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredTask {
    pub snapshot: RemoteTaskSnapshot,
    pub request: Option<RemoteTaskCreateRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdempotencyRecord {
    pub device_id: String,
    pub request_id: String,
    pub task_id: String,
    pub fingerprint: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredDevice {
    pub device_id: String,
    pub token_hash: [u8; 32],
    pub display_name: String,
    pub platform: String,
    pub identity_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationAcceptance {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub request_id: String,
    pub project_id: String,
    pub title: Option<String>,
    pub user_message_id: String,
    pub delivery_id: String,
    pub prompt: String,
    pub context_json: Vec<u8>,
    /// Immutable per-turn model binding, verified by the runtime before prompt
    /// delivery. `None` = host default at acceptance time.
    pub model_ref: Option<String>,
    pub created_at_ms: u64,
    pub created_at: String,
    pub request_fingerprint: String,
    pub idempotency_expires_at_ms: u64,
    pub event_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationAppendAcceptance {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub request_id: String,
    pub user_message_id: String,
    pub delivery_id: String,
    pub prompt: String,
    pub context_json: Vec<u8>,
    /// Immutable per-turn model binding; also advances the conversation
    /// default when present.
    pub model_ref: Option<String>,
    pub created_at_ms: u64,
    pub created_at: String,
    pub request_fingerprint: String,
    pub idempotency_expires_at_ms: u64,
    pub event_id: String,
}

/// Runtime-driven input for one durable turn state transition. Storage
/// enforces the contract turn state machine and commits the semantic outbox
/// event in the same transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnExecutionInput {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub at_ms: u64,
    pub at: String,
    pub event_id: String,
}

/// Runtime-driven input for the terminal commit of one turn. On success the
/// assistant final message and the terminal turn state commit atomically so a
/// snapshot can never expose success without the durable final message.
#[derive(Clone, Debug, PartialEq)]
pub struct TurnCompletionInput {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub terminal: RemoteTurnTerminalState,
    pub error: Option<RemoteConversationError>,
    pub assistant_message_id: Option<String>,
    pub assistant_text: Option<String>,
    pub mark_delivery_failed: bool,
    pub at_ms: u64,
    pub at: String,
    pub state_changed_event_id: String,
    pub completed_event_id: String,
    pub message_completed_event_id: String,
    pub status_changed_event_id: String,
}

/// Next queued turn eligible for dispatch, carrying everything the runtime
/// needs to deliver it. Owner/project revalidation happens again at dispatch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchableTurn {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub project_id: String,
    pub turn_id: String,
    pub request_id: String,
    pub prompt: String,
    pub context_json: Vec<u8>,
    /// Immutable per-turn model binding from acceptance.
    pub model_ref: Option<String>,
    pub created_at_ms: u64,
}

/// Gateway-stored v2 semantic event row from the shared outbox.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredConversationEvent {
    pub device_id: String,
    pub sequence: u64,
    pub event_id: String,
    pub emitted_at_ms: u64,
    pub payload: RemoteConversationEvent,
}

/// Gateway-private Pi session binding. Never serialized into network DTOs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConversationSessionRecord {
    pub owner_device_id: String,
    pub conversation_id: String,
    pub session_id: String,
    pub relative_ref: String,
    pub pi_version: String,
    pub format_fingerprint: String,
    pub state: String,
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct StorageLimits {
    pub max_tasks: usize,
    pub max_events: usize,
}

impl Default for StorageLimits {
    fn default() -> Self {
        Self {
            max_tasks: MAX_TASKS,
            max_events: MAX_EVENTS,
        }
    }
}

impl StorageLimits {
    fn bounded(self) -> Self {
        Self {
            max_tasks: if self.max_tasks == 0 || self.max_tasks > MAX_TASKS {
                MAX_TASKS
            } else {
                self.max_tasks
            },
            max_events: if self.max_events == 0 || self.max_events > MAX_EVENTS {
                MAX_EVENTS
            } else {
                self.max_events
            },
        }
    }
}

pub struct RemoteStorage {
    path: PathBuf,
    connection: Mutex<Connection>,
    limits: StorageLimits,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationOptions {
    pub failure_point: Option<MigrationFailurePoint>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MigrationFailurePoint {
    BeforeRestorePoint,
    AfterRestorePoint,
    AfterV3Tables,
    AfterV4Tables,
}

impl RemoteStorage {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        Self::open_with_limits(path, StorageLimits::default())
    }

    pub fn open_with_limits(
        path: impl Into<PathBuf>,
        limits: StorageLimits,
    ) -> Result<Self, StorageError> {
        Self::open_with_limits_and_migration_options(path, limits, MigrationOptions::default())
    }

    pub fn open_with_limits_and_migration_options(
        path: impl Into<PathBuf>,
        limits: StorageLimits,
        migration_options: MigrationOptions,
    ) -> Result<Self, StorageError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| StorageError::Database)?;
        }
        let mut connection = Connection::open(&path).map_err(map_database_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(map_database_error)?;
        configure_and_migrate(&mut connection, &path, migration_options)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
            limits: limits.bounded(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit_task_event(
        &self,
        snapshot: &RemoteTaskSnapshot,
        event: &StoredEvent,
        idempotency: Option<&IdempotencyRecord>,
    ) -> Result<(), StorageError> {
        self.commit_task_event_with_request(snapshot, event, idempotency, None)
    }

    pub fn create_conversation_turn(
        &self,
        acceptance: &ConversationAcceptance,
    ) -> Result<RemoteConversationCreateResponse, StorageError> {
        validate_conversation_acceptance(acceptance)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        if let Some((result_ref, fingerprint)) = load_conversation_idempotency(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.request_id,
            "create",
        )? {
            if fingerprint != acceptance.request_fingerprint || result_ref != acceptance.turn_id {
                return Err(StorageError::IdempotencyConflict);
            }
            let response = load_conversation_create_response_locked(
                &transaction,
                &acceptance.owner_device_id,
                &acceptance.conversation_id,
                &acceptance.turn_id,
                &acceptance.user_message_id,
            )?;
            transaction.commit().map_err(map_database_error)?;
            return Ok(response);
        }

        transaction
            .execute(
                "INSERT INTO conversations(conversation_id, owner_device_id, project_id, status, title, created_at_ms, updated_at_ms, archived_at_ms, default_model_ref)
                 VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?5, NULL, ?6)",
                params![
                    acceptance.conversation_id,
                    acceptance.owner_device_id,
                    acceptance.project_id,
                    acceptance.title,
                    acceptance.created_at_ms as i64,
                    acceptance.model_ref,
                ],
            )
            .map_err(map_database_error)?;
        insert_turn_message_idempotency(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.turn_id,
            &acceptance.request_id,
            &acceptance.user_message_id,
            &acceptance.delivery_id,
            &acceptance.prompt,
            &acceptance.context_json,
            acceptance.model_ref.as_deref(),
            acceptance.created_at_ms,
            "create",
            &acceptance.request_fingerprint,
            acceptance.idempotency_expires_at_ms,
            1,
        )?;
        let response = load_conversation_create_response_locked(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.turn_id,
            &acceptance.user_message_id,
        )?;
        let sequence = next_raw_event_sequence(&transaction, &acceptance.owner_device_id)?;
        let event = RemoteConversationEvent::ConversationCreated(
            crate::conversation_protocol::RemoteConversationCreatedEvent {
                base: RemoteConversationEventBase {
                    event_id: acceptance.event_id.clone(),
                    emitted_at: acceptance.created_at.clone(),
                    sequence,
                    device_id: acceptance.owner_device_id.clone(),
                    conversation_id: acceptance.conversation_id.clone(),
                },
                conversation: response.conversation.clone(),
            },
        );
        insert_raw_conversation_event(
            &transaction,
            &acceptance.owner_device_id,
            sequence,
            &acceptance.event_id,
            acceptance.created_at_ms,
            &event,
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(response)
    }

    pub fn append_conversation_turn(
        &self,
        acceptance: &ConversationAppendAcceptance,
    ) -> Result<RemoteTurnAppendResponse, StorageError> {
        validate_conversation_append_acceptance(acceptance)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
        )?;
        if let Some((result_ref, fingerprint)) = load_conversation_idempotency(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.request_id,
            "append",
        )? {
            if fingerprint != acceptance.request_fingerprint || result_ref != acceptance.turn_id {
                return Err(StorageError::IdempotencyConflict);
            }
            let response = load_turn_append_response_locked(
                &transaction,
                &acceptance.owner_device_id,
                &acceptance.conversation_id,
                &acceptance.turn_id,
                &acceptance.user_message_id,
                true,
            )?;
            transaction.commit().map_err(map_database_error)?;
            return Ok(response);
        }

        let queued_count: i64 = transaction
            .query_row(
                "SELECT COUNT(*) FROM turns WHERE conversation_id=?1 AND state='queued'",
                params![acceptance.conversation_id],
                |row| row.get(0),
            )
            .map_err(map_database_error)?;
        if queued_count >= i64::from(REMOTE_CONVERSATION_MAX_QUEUED_TURNS) {
            return Err(StorageError::QueueFull);
        }

        let ordinal = next_message_ordinal(&transaction, &acceptance.conversation_id)?;
        insert_turn_message_idempotency(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.turn_id,
            &acceptance.request_id,
            &acceptance.user_message_id,
            &acceptance.delivery_id,
            &acceptance.prompt,
            &acceptance.context_json,
            acceptance.model_ref.as_deref(),
            acceptance.created_at_ms,
            "append",
            &acceptance.request_fingerprint,
            acceptance.idempotency_expires_at_ms,
            ordinal,
        )?;
        transaction
            .execute(
                "UPDATE conversations SET status='queued', updated_at_ms=?1,
                        default_model_ref=COALESCE(?2, default_model_ref)
                 WHERE conversation_id=?3",
                params![
                    acceptance.created_at_ms as i64,
                    acceptance.model_ref,
                    acceptance.conversation_id,
                ],
            )
            .map_err(map_database_error)?;
        let response = load_turn_append_response_locked(
            &transaction,
            &acceptance.owner_device_id,
            &acceptance.conversation_id,
            &acceptance.turn_id,
            &acceptance.user_message_id,
            false,
        )?;
        let sequence = next_raw_event_sequence(&transaction, &acceptance.owner_device_id)?;
        let event = RemoteConversationEvent::TurnCreated(
            crate::conversation_protocol::RemoteTurnCreatedEvent {
                base: RemoteConversationEventBase {
                    event_id: acceptance.event_id.clone(),
                    emitted_at: acceptance.created_at.clone(),
                    sequence,
                    device_id: acceptance.owner_device_id.clone(),
                    conversation_id: acceptance.conversation_id.clone(),
                },
                turn: response.turn.clone(),
            },
        );
        insert_raw_conversation_event(
            &transaction,
            &acceptance.owner_device_id,
            sequence,
            &acceptance.event_id,
            acceptance.created_at_ms,
            &event,
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(response)
    }

    /// Appends one live conversation event (message.delta / tool.*) to the
    /// owner outbox in its own small transaction so the streaming lane can
    /// emit while a turn is still running (the terminal `complete_turn`
    /// remains the single authority for the final message). `build_event`
    /// receives the assigned owner-scoped sequence so the serialized event
    /// and the outbox sequence column always agree.
    pub fn append_streaming_conversation_event<F>(
        &self,
        owner_device_id: &str,
        event_id: &str,
        emitted_at_ms: u64,
        build_event: F,
    ) -> Result<u64, StorageError>
    where
        F: FnOnce(u64) -> RemoteConversationEvent,
    {
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        let sequence = next_raw_event_sequence(&transaction, owner_device_id)?;
        let event = build_event(sequence);
        insert_raw_conversation_event(
            &transaction,
            owner_device_id,
            sequence,
            event_id,
            emitted_at_ms,
            &event,
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(sequence)
    }

    pub fn load_conversation(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
    ) -> Result<Option<RemoteConversationSnapshot>, StorageError> {        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        if !owner_conversation_exists_optional(&connection, owner_device_id, conversation_id)? {
            return Ok(None);
        }
        load_conversation_snapshot(&connection, owner_device_id, conversation_id).map(Some)
    }

    pub fn list_conversations(
        &self,
        owner_device_id: &str,
        limit: usize,
    ) -> Result<Vec<RemoteConversationSnapshot>, StorageError> {
        validate_key(owner_device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT conversation_id FROM conversations
                 WHERE owner_device_id=?1
                 ORDER BY updated_at_ms DESC, conversation_id ASC
                 LIMIT ?2",
            )
            .map_err(map_database_error)?;
        let ids = statement
            .query_map(params![owner_device_id, limit.min(100) as i64], |row| {
                row.get::<_, String>(0)
            })
            .map_err(map_database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_database_error)?;
        ids.into_iter()
            .map(|id| load_conversation_snapshot(&connection, owner_device_id, &id))
            .collect()
    }

    /// Local-desktop administration query across paired-device owners.
    ///
    /// Network routes must continue to use [`Self::list_conversations`] so a
    /// mobile principal can never cross the owner boundary. This method exists
    /// only for the in-process Tauri bridge that owns the gateway database.
    pub fn list_conversations_for_desktop(
        &self,
        limit: usize,
    ) -> Result<Vec<RemoteConversationSnapshot>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT owner_device_id, conversation_id FROM conversations
                 ORDER BY updated_at_ms DESC, conversation_id ASC
                 LIMIT ?1",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(params![limit.min(100) as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_database_error)?;
        rows.into_iter()
            .map(|(owner, id)| load_conversation_snapshot(&connection, &owner, &id))
            .collect()
    }

    /// Loads one conversation for the local desktop bridge without requiring
    /// the UI to know or transmit its owning device ID.
    pub fn load_conversation_for_desktop(
        &self,
        conversation_id: &str,
    ) -> Result<Option<RemoteConversationSnapshot>, StorageError> {
        validate_key(conversation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let owner = connection
            .query_row(
                "SELECT owner_device_id FROM conversations WHERE conversation_id=?1",
                params![conversation_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_database_error)?;
        owner
            .map(|owner| load_conversation_snapshot(&connection, &owner, conversation_id))
            .transpose()
    }

    pub fn load_conversation_messages_for_desktop(
        &self,
        conversation_id: &str,
        after_ordinal: Option<u64>,
        limit: usize,
    ) -> Result<Option<RemoteMessagePageResponse>, StorageError> {
        validate_key(conversation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let exists = connection
            .query_row(
                "SELECT 1 FROM conversations WHERE conversation_id=?1",
                params![conversation_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(map_database_error)?
            .is_some();
        if !exists {
            return Ok(None);
        }
        let page_limit = limit.min(REMOTE_CONVERSATION_MAX_PAGE_SIZE).max(1);
        let rows = load_messages_after(
            &connection,
            conversation_id,
            after_ordinal.unwrap_or(0),
            page_limit + 1,
        )?;
        let next_cursor = rows.get(page_limit).map(|(ordinal, _)| ordinal.to_string());
        let messages = rows
            .into_iter()
            .take(page_limit)
            .map(|(_, message)| message)
            .collect();
        Ok(Some(RemoteMessagePageResponse {
            conversation_id: conversation_id.to_owned(),
            messages,
            next_cursor,
        }))
    }

    /// Desktop-host append across owners. The desktop bridge is the gateway
    /// owner and may append to any paired device's conversation; network
    /// routes must keep using [`Self::append_conversation_turn`] so a mobile
    /// principal can never cross the owner boundary. Idempotent by the
    /// caller-supplied `request_id`.
    pub fn append_conversation_turn_for_desktop(
        &self,
        conversation_id: &str,
        prompt: &str,
        context_json: Vec<u8>,
        model_ref: Option<String>,
        request_id: String,
        event_id: String,
    ) -> Result<RemoteTurnAppendResponse, StorageError> {
        validate_key(conversation_id)?;
        validate_key(&request_id)?;
        validate_key(&event_id)?;
        if prompt.is_empty()
            || prompt.len() > REMOTE_CONVERSATION_MAX_PROMPT_BYTES
            || context_json.len() > MAX_REQUEST_BYTES
        {
            return Err(StorageError::PayloadTooLarge);
        }
        let owner = self
            .load_conversation_for_desktop(conversation_id)?
            .ok_or(StorageError::InvalidKey)?
            .owner_device_id;
        let (created_at_ms, created_at) = {
            let ms = now_ms();
            (ms, crate::task_manager::format_timestamp(ms))
        };
        let turn_material = format!("desktop:{conversation_id}:{request_id}");
        let turn_id = deterministic_id("turn", &turn_material);
        let user_message_id = deterministic_id("msg", &turn_material);
        let delivery_id = deterministic_id("dlv", &turn_material);
        self.append_conversation_turn(&ConversationAppendAcceptance {
            owner_device_id: owner,
            conversation_id: conversation_id.to_owned(),
            turn_id,
            request_id,
            user_message_id,
            delivery_id,
            prompt: prompt.to_owned(),
            context_json,
            model_ref,
            created_at_ms,
            created_at,
            request_fingerprint: format!("desktop:{conversation_id}"),
            idempotency_expires_at_ms: created_at_ms + 24 * 60 * 60 * 1000,
            event_id,
        })
    }

    pub fn load_conversation_messages(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
        after_ordinal: Option<u64>,
        limit: usize,
    ) -> Result<Option<RemoteMessagePageResponse>, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        if !owner_conversation_exists_optional(&connection, owner_device_id, conversation_id)? {
            return Ok(None);
        }
        let page_limit = limit.min(REMOTE_CONVERSATION_MAX_PAGE_SIZE).max(1);
        let rows = load_messages_after(
            &connection,
            conversation_id,
            after_ordinal.unwrap_or(0),
            page_limit + 1,
        )?;
        let next_cursor = rows.get(page_limit).map(|(ordinal, _)| ordinal.to_string());
        let messages = rows
            .into_iter()
            .take(page_limit)
            .map(|(_, message)| message)
            .collect();
        Ok(Some(RemoteMessagePageResponse {
            conversation_id: conversation_id.to_owned(),
            messages,
            next_cursor,
        }))
    }

    /// Marks a queued turn as starting execution. The transition and its
    /// semantic outbox event commit in one transaction.
    pub fn mark_turn_started(
        &self,
        input: &TurnExecutionInput,
    ) -> Result<RemoteTurnSnapshot, StorageError> {
        self.transition_turn(input, RemoteTurnState::Starting, None, Some("delivered"))
    }

    /// Marks a starting or awaiting_input turn as running (prompt delivered).
    pub fn mark_turn_running(
        &self,
        input: &TurnExecutionInput,
    ) -> Result<RemoteTurnSnapshot, StorageError> {
        self.transition_turn(input, RemoteTurnState::Running, None, None)
    }

    /// Marks a running turn as awaiting an extension interaction.
    pub fn mark_turn_awaiting_input(
        &self,
        input: &TurnExecutionInput,
    ) -> Result<RemoteTurnSnapshot, StorageError> {
        self.transition_turn(input, RemoteTurnState::AwaitingInput, None, None)
    }

    fn transition_turn(
        &self,
        input: &TurnExecutionInput,
        to_state: RemoteTurnState,
        error: Option<RemoteConversationError>,
        delivery_update: Option<&'static str>,
    ) -> Result<RemoteTurnSnapshot, StorageError> {
        validate_turn_execution_input(input)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, &input.owner_device_id, &input.conversation_id)?;
        let (from_state, prev_status, new_status) = apply_turn_transition(
            &transaction,
            &input.owner_device_id,
            &input.conversation_id,
            &input.turn_id,
            &to_state,
            error.as_ref(),
            input.at_ms,
            delivery_update,
        )?;
        let mut sequence = next_raw_event_sequence(&transaction, &input.owner_device_id)?;
        let status_event_id = format!("{}:status", input.event_id);
        insert_raw_conversation_event(
            &transaction,
            &input.owner_device_id,
            sequence,
            &input.event_id,
            input.at_ms,
            &turn_state_changed_event(
                &input.owner_device_id,
                &input.conversation_id,
                &input.event_id,
                &input.at,
                sequence,
                &input.turn_id,
                &from_state,
                &to_state,
                error.clone(),
            ),
        )?;
        if new_status != prev_status {
            sequence += 1;
            insert_raw_conversation_event(
                &transaction,
                &input.owner_device_id,
                sequence,
                &status_event_id,
                input.at_ms,
                &status_changed_event(
                    &input.owner_device_id,
                    &input.conversation_id,
                    &status_event_id,
                    &input.at,
                    sequence,
                    &prev_status,
                    &new_status,
                ),
            )?;
        }
        let snapshot = load_turn(
            &transaction,
            &input.owner_device_id,
            &input.conversation_id,
            &input.turn_id,
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(snapshot)
    }

    /// Commits a turn's terminal state. On success the assistant final
    /// message, the terminal turn state, and all semantic events commit in
    /// one transaction, so no snapshot can expose success without the final
    /// durable message.
    pub fn complete_turn(
        &self,
        input: &TurnCompletionInput,
    ) -> Result<RemoteTurnSnapshot, StorageError> {
        validate_turn_completion_input(input)?;
        let to_state = terminal_to_turn_state(&input.terminal);
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, &input.owner_device_id, &input.conversation_id)?;
        let mut assistant_message: Option<RemoteMessage> = None;
        if let (Some(message_id), Some(text)) = (&input.assistant_message_id, &input.assistant_text)
        {
            if text.len() > REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES {
                return Err(StorageError::PayloadTooLarge);
            }
            let ordinal = next_message_ordinal(&transaction, &input.conversation_id)?;
            let status = match input.terminal {
                RemoteTurnTerminalState::Succeeded => RemoteMessageStatus::Completed,
                RemoteTurnTerminalState::Failed => RemoteMessageStatus::Failed,
                RemoteTurnTerminalState::Cancelled => RemoteMessageStatus::Cancelled,
            };
            transaction
                .execute(
                    "INSERT INTO messages(message_id, conversation_id, turn_id, ordinal, role, status, content_blob, created_at_ms, completed_at_ms)
                     VALUES (?1, ?2, ?3, ?4, 'assistant', ?5, ?6, ?7, ?7)",
                    params![
                        message_id,
                        input.conversation_id,
                        input.turn_id,
                        ordinal as i64,
                        message_status_to_db(&status),
                        text.as_bytes(),
                        input.at_ms as i64
                    ],
                )
                .map_err(map_database_error)?;
            assistant_message = Some(RemoteMessage {
                message_id: message_id.clone(),
                conversation_id: input.conversation_id.clone(),
                turn_id: input.turn_id.clone(),
                role: RemoteMessageRole::Assistant,
                status,
                text: text.clone(),
                created_at: input.at.clone(),
                updated_at: input.at.clone(),
                completed_at: Some(input.at.clone()),
                error: None,
            });
        }
        let delivery_update = if input.mark_delivery_failed {
            Some("failed")
        } else {
            None
        };
        let (from_state, prev_status, new_status) = apply_turn_transition(
            &transaction,
            &input.owner_device_id,
            &input.conversation_id,
            &input.turn_id,
            &to_state,
            input.error.as_ref(),
            input.at_ms,
            delivery_update,
        )?;
        let mut sequence = next_raw_event_sequence(&transaction, &input.owner_device_id)?;
        insert_raw_conversation_event(
            &transaction,
            &input.owner_device_id,
            sequence,
            &input.state_changed_event_id,
            input.at_ms,
            &turn_state_changed_event(
                &input.owner_device_id,
                &input.conversation_id,
                &input.state_changed_event_id,
                &input.at,
                sequence,
                &input.turn_id,
                &from_state,
                &to_state,
                input.error.clone(),
            ),
        )?;
        if let Some(message) = &assistant_message {
            sequence += 1;
            insert_raw_conversation_event(
                &transaction,
                &input.owner_device_id,
                sequence,
                &input.message_completed_event_id,
                input.at_ms,
                &RemoteConversationEvent::MessageCompleted(RemoteMessageCompletedEvent {
                    base: conversation_event_base(
                        &input.message_completed_event_id,
                        &input.at,
                        sequence,
                        &input.owner_device_id,
                        &input.conversation_id,
                    ),
                    message: message.clone(),
                }),
            )?;
        }
        sequence += 1;
        insert_raw_conversation_event(
            &transaction,
            &input.owner_device_id,
            sequence,
            &input.completed_event_id,
            input.at_ms,
            &RemoteConversationEvent::TurnCompleted(RemoteTurnCompletedEvent {
                base: conversation_event_base(
                    &input.completed_event_id,
                    &input.at,
                    sequence,
                    &input.owner_device_id,
                    &input.conversation_id,
                ),
                turn_id: input.turn_id.clone(),
                state: input.terminal.clone(),
                assistant_message_id: input.assistant_message_id.clone(),
                error: input.error.clone(),
            }),
        )?;
        if new_status != prev_status {
            sequence += 1;
            insert_raw_conversation_event(
                &transaction,
                &input.owner_device_id,
                sequence,
                &input.status_changed_event_id,
                input.at_ms,
                &status_changed_event(
                    &input.owner_device_id,
                    &input.conversation_id,
                    &input.status_changed_event_id,
                    &input.at,
                    sequence,
                    &prev_status,
                    &new_status,
                ),
            )?;
        }
        let snapshot = load_turn(
            &transaction,
            &input.owner_device_id,
            &input.conversation_id,
            &input.turn_id,
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(snapshot)
    }

    /// Fails every queued turn of one conversation (project revocation or
    /// archive). In-flight turns are the runtime's cancel responsibility.
    /// Deterministic event IDs keep the operation itself idempotent-friendly.
    pub fn fail_queued_turns(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
        error: &RemoteConversationError,
        at_ms: u64,
        at: &str,
    ) -> Result<u64, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        if at.is_empty() {
            return Err(StorageError::InvalidKey);
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, owner_device_id, conversation_id)?;
        let prev_status = parse_conversation_status(&conversation_status_column(
            &transaction,
            owner_device_id,
            conversation_id,
        )?)?;
        let turn_ids: Vec<String> = transaction
            .prepare(
                "SELECT turn_id FROM turns WHERE conversation_id=?1 AND state='queued'
                 ORDER BY created_at_ms ASC, turn_id ASC",
            )
            .map_err(map_database_error)?
            .query_map(params![conversation_id], |row| row.get::<_, String>(0))
            .map_err(map_database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_database_error)?;
        let mut sequence = next_raw_event_sequence(&transaction, owner_device_id)?;
        for turn_id in &turn_ids {
            apply_turn_transition(
                &transaction,
                owner_device_id,
                conversation_id,
                turn_id,
                &RemoteTurnState::Failed,
                Some(error),
                at_ms,
                Some("failed"),
            )?;
            let state_changed_id = format!("fail-queued-{turn_id}-{at_ms}");
            let completed_id = format!("fail-queued-{turn_id}-{at_ms}:completed");
            insert_raw_conversation_event(
                &transaction,
                owner_device_id,
                sequence,
                &state_changed_id,
                at_ms,
                &turn_state_changed_event(
                    owner_device_id,
                    conversation_id,
                    &state_changed_id,
                    at,
                    sequence,
                    turn_id,
                    &RemoteTurnState::Queued,
                    &RemoteTurnState::Failed,
                    Some(error.clone()),
                ),
            )?;
            sequence += 1;
            insert_raw_conversation_event(
                &transaction,
                owner_device_id,
                sequence,
                &completed_id,
                at_ms,
                &RemoteConversationEvent::TurnCompleted(RemoteTurnCompletedEvent {
                    base: conversation_event_base(
                        &completed_id,
                        at,
                        sequence,
                        owner_device_id,
                        conversation_id,
                    ),
                    turn_id: turn_id.clone(),
                    state: RemoteTurnTerminalState::Failed,
                    assistant_message_id: None,
                    error: Some(error.clone()),
                }),
            )?;
            sequence += 1;
        }
        if !turn_ids.is_empty() {
            let new_status =
                derive_conversation_status_locked(&transaction, owner_device_id, conversation_id)?;
            if new_status != prev_status {
                let status_id = format!("fail-queued-{conversation_id}-{at_ms}:status");
                insert_raw_conversation_event(
                    &transaction,
                    owner_device_id,
                    sequence,
                    &status_id,
                    at_ms,
                    &status_changed_event(
                        owner_device_id,
                        conversation_id,
                        &status_id,
                        at,
                        sequence,
                        &prev_status,
                        &new_status,
                    ),
                )?;
            }
        }
        transaction.commit().map_err(map_database_error)?;
        Ok(turn_ids.len() as u64)
    }

    /// Startup recovery: marks turns that were in flight when the desktop
    /// disappeared as `failed(host_interrupted)` exactly once and never
    /// replays them. Queued turns remain dispatchable durable intent.
    pub fn recover_non_terminal_turns(
        &self,
        emitted_at_ms: u64,
        emitted_at: &str,
    ) -> Result<Vec<(String, String)>, StorageError> {
        if emitted_at.is_empty() {
            return Err(StorageError::InvalidKey);
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        let error = RemoteConversationError {
            code: RemoteConversationErrorCode::HostInterrupted,
            message: "desktop restarted while the turn was active".to_owned(),
            retryable: false,
        };
        let rows: Vec<(String, String, String)> = transaction
            .prepare(
                "SELECT t.turn_id, t.conversation_id, c.owner_device_id FROM turns t
                 JOIN conversations c ON c.conversation_id = t.conversation_id
                 WHERE t.state IN ('starting','running','awaiting_input')
                 ORDER BY t.created_at_ms ASC, t.turn_id ASC",
            )
            .map_err(map_database_error)?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(map_database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_database_error)?;
        let mut sequences: HashMap<String, u64> = HashMap::new();
        let mut conversation_status: Vec<(String, String, RemoteConversationStatus)> = Vec::new();
        let mut recovered: Vec<(String, String)> = Vec::new();
        for (turn_id, conversation_id, owner_device_id) in &rows {
            if !sequences.contains_key(owner_device_id) {
                sequences.insert(
                    owner_device_id.clone(),
                    next_raw_event_sequence(&transaction, owner_device_id)?,
                );
                let prev = parse_conversation_status(&conversation_status_column(
                    &transaction,
                    owner_device_id,
                    conversation_id,
                )?)?;
                conversation_status.push((owner_device_id.clone(), conversation_id.clone(), prev));
            }
            let (from_state, _, _) = apply_turn_transition(
                &transaction,
                owner_device_id,
                conversation_id,
                turn_id,
                &RemoteTurnState::Failed,
                Some(&error),
                emitted_at_ms,
                None,
            )?;
            let mut sequence = sequences[owner_device_id];
            let state_changed_id = format!("recovery-turn-{turn_id}-{emitted_at_ms}");
            let completed_id = format!("recovery-turn-{turn_id}-{emitted_at_ms}:completed");
            insert_raw_conversation_event(
                &transaction,
                owner_device_id,
                sequence,
                &state_changed_id,
                emitted_at_ms,
                &turn_state_changed_event(
                    owner_device_id,
                    conversation_id,
                    &state_changed_id,
                    emitted_at,
                    sequence,
                    turn_id,
                    &from_state,
                    &RemoteTurnState::Failed,
                    Some(error.clone()),
                ),
            )?;
            sequence += 1;
            insert_raw_conversation_event(
                &transaction,
                owner_device_id,
                sequence,
                &completed_id,
                emitted_at_ms,
                &RemoteConversationEvent::TurnCompleted(RemoteTurnCompletedEvent {
                    base: conversation_event_base(
                        &completed_id,
                        emitted_at,
                        sequence,
                        owner_device_id,
                        conversation_id,
                    ),
                    turn_id: turn_id.clone(),
                    state: RemoteTurnTerminalState::Failed,
                    assistant_message_id: None,
                    error: Some(error.clone()),
                }),
            )?;
            sequences.insert(owner_device_id.clone(), sequence + 1);
            recovered.push((conversation_id.clone(), turn_id.clone()));
        }
        for (owner_device_id, conversation_id, prev_status) in &conversation_status {
            let new_status =
                derive_conversation_status_locked(&transaction, owner_device_id, conversation_id)?;
            if new_status != *prev_status {
                let sequence = sequences[owner_device_id];
                let status_id = format!("recovery-status-{conversation_id}-{emitted_at_ms}");
                insert_raw_conversation_event(
                    &transaction,
                    owner_device_id,
                    sequence,
                    &status_id,
                    emitted_at_ms,
                    &status_changed_event(
                        owner_device_id,
                        conversation_id,
                        &status_id,
                        emitted_at,
                        sequence,
                        prev_status,
                        &new_status,
                    ),
                )?;
                sequences.insert(owner_device_id.clone(), sequence + 1);
            }
        }
        transaction.commit().map_err(map_database_error)?;
        Ok(recovered)
    }

    /// Count of turns executing right now (starting/running/awaiting_input).
    /// The runtime manager compares this against the global one-active-turn
    /// limit before dispatching.
    pub fn count_active_turns(&self) -> Result<u64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT COUNT(*) FROM turns
                 WHERE state IN ('starting','running','awaiting_input')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(map_database_error)
    }

    pub fn count_active_conversations(&self) -> Result<u64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT COUNT(DISTINCT conversation_id) FROM turns
                 WHERE state IN ('starting','running','awaiting_input')",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(map_database_error)
    }

    pub fn count_queued_turns(&self) -> Result<u64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT COUNT(*) FROM turns WHERE state='queued' AND delivery_state='accepted'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|value| value as u64)
            .map_err(map_database_error)
    }

    /// Oldest queued, not-yet-delivered turn in a non-archived conversation,
    /// carrying everything the runtime needs for dispatch.
    pub fn next_dispatchable_turn(&self) -> Result<Option<DispatchableTurn>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let row = connection
            .query_row(
                "SELECT t.turn_id, t.conversation_id, t.request_id, t.context_json,
                        t.created_at_ms, t.model_ref, c.owner_device_id, c.project_id
                 FROM turns t
                 JOIN conversations c ON c.conversation_id = t.conversation_id
                 WHERE t.state='queued' AND t.delivery_state='accepted'
                   AND c.archived_at_ms IS NULL
                   AND c.status != 'unavailable'
                 ORDER BY t.created_at_ms ASC, t.turn_id ASC
                 LIMIT 1",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()
            .map_err(map_database_error)?;
        let Some((
            turn_id,
            conversation_id,
            request_id,
            context_json,
            created_at_ms,
            model_ref,
            owner,
            project_id,
        )) = row
        else {
            return Ok(None);
        };
        let prompt_bytes: Vec<u8> = connection
            .query_row(
                "SELECT content_blob FROM messages
                 WHERE conversation_id=?1 AND turn_id=?2 AND role='user'
                 ORDER BY ordinal ASC LIMIT 1",
                params![conversation_id, turn_id],
                |row| row.get(0),
            )
            .map_err(map_database_error)?;
        let prompt = String::from_utf8(prompt_bytes).map_err(|_| StorageError::Corrupt)?;
        Ok(Some(DispatchableTurn {
            owner_device_id: owner,
            conversation_id,
            project_id,
            turn_id,
            request_id,
            prompt,
            context_json,
            model_ref,
            created_at_ms: created_at_ms as u64,
        }))
    }

    /// Owner-gated lookup of the conversation containing a turn (cancel route).
    pub fn conversation_for_turn(
        &self,
        owner_device_id: &str,
        turn_id: &str,
    ) -> Result<Option<String>, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(turn_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT c.conversation_id FROM turns t
                 JOIN conversations c ON c.conversation_id = t.conversation_id
                 WHERE t.turn_id=?1 AND c.owner_device_id=?2",
                params![turn_id, owner_device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_database_error)
    }

    /// Loads one turn snapshot, owner-gated like every other read.
    pub fn load_turn_snapshot(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<Option<RemoteTurnSnapshot>, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        validate_key(turn_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        if !owner_conversation_exists_optional(&connection, owner_device_id, conversation_id)? {
            return Ok(None);
        }
        let exists: Option<i64> = connection
            .query_row(
                "SELECT 1 FROM turns WHERE conversation_id=?1 AND turn_id=?2",
                params![conversation_id, turn_id],
                |_| Ok(1),
            )
            .optional()
            .map_err(map_database_error)?;
        if exists.is_none() {
            return Ok(None);
        }
        load_turn(&connection, owner_device_id, conversation_id, turn_id).map(Some)
    }

    /// Device-scoped replay of v2 semantic events from the shared outbox.
    /// Returns the events plus a gap flag: the caller passed a cursor that
    /// the retained sequence space can no longer cover, so reconciliation
    /// must fall back to authoritative snapshots.
    pub fn load_conversation_events(
        &self,
        device_id: &str,
        after: Option<u64>,
        limit: usize,
    ) -> Result<(Vec<StoredConversationEvent>, bool), StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let gap = if let Some(after) = after {
            let oldest: Option<i64> = connection
                .query_row(
                    "SELECT MIN(sequence) FROM events
                     WHERE device_id=?1
                       AND json_extract(CAST(event_json AS TEXT), '$.conversationId') IS NOT NULL",
                    params![device_id],
                    |row| row.get(0),
                )
                .map_err(map_database_error)?;
            oldest.is_some_and(|oldest| oldest as u64 > after + 1)
        } else {
            false
        };
        let page_limit = limit.min(500).max(1);
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, emitted_at_ms, event_json FROM events
                 WHERE device_id=?1
                   AND (?2 IS NULL OR sequence>?2)
                   AND json_extract(CAST(event_json AS TEXT), '$.conversationId') IS NOT NULL
                 ORDER BY sequence ASC
                 LIMIT ?3",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(
                params![
                    device_id,
                    after.map(|value| value as i64),
                    page_limit as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? as u64,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)? as u64,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .map_err(map_database_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_database_error)?;
        let mut events = Vec::with_capacity(rows.len());
        for (sequence, event_id, emitted_at_ms, bytes) in rows {
            let payload: RemoteConversationEvent =
                serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)?;
            events.push(StoredConversationEvent {
                device_id: device_id.to_owned(),
                sequence,
                event_id,
                emitted_at_ms,
                payload,
            });
        }
        Ok((events, gap))
    }

    /// Upserts the gateway-private Pi session binding for a conversation.
    /// The record never leaves the server process.
    pub fn store_conversation_session(
        &self,
        record: &ConversationSessionRecord,
    ) -> Result<(), StorageError> {
        validate_conversation_session_record(record)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(
            &transaction,
            &record.owner_device_id,
            &record.conversation_id,
        )?;
        transaction
            .execute(
                "INSERT INTO conversation_sessions(conversation_id, session_id, relative_ref, pi_version, format_fingerprint, state, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(conversation_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    relative_ref=excluded.relative_ref,
                    pi_version=excluded.pi_version,
                    format_fingerprint=excluded.format_fingerprint,
                    state=excluded.state,
                    updated_at_ms=excluded.updated_at_ms",
                params![
                    record.conversation_id,
                    record.session_id,
                    record.relative_ref,
                    record.pi_version,
                    record.format_fingerprint,
                    record.state,
                    record.updated_at_ms as i64
                ],
            )
            .map_err(map_database_error)?;
        transaction
            .execute(
                "UPDATE conversations SET updated_at_ms=?1 WHERE conversation_id=?2",
                params![record.updated_at_ms as i64, record.conversation_id],
            )
            .map_err(map_database_error)?;
        transaction.commit().map_err(map_database_error)
    }

    /// Loads the private session binding, owner-gated like every other
    /// conversation read.
    pub fn load_conversation_session(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
    ) -> Result<Option<ConversationSessionRecord>, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        if !owner_conversation_exists_optional(&connection, owner_device_id, conversation_id)? {
            return Ok(None);
        }
        connection
            .query_row(
                "SELECT session_id, relative_ref, pi_version, format_fingerprint, state, updated_at_ms
                 FROM conversation_sessions WHERE conversation_id=?1",
                params![conversation_id],
                |row| {
                    Ok(ConversationSessionRecord {
                        owner_device_id: owner_device_id.to_owned(),
                        conversation_id: conversation_id.to_owned(),
                        session_id: row.get(0)?,
                        relative_ref: row.get(1)?,
                        pi_version: row.get(2)?,
                        format_fingerprint: row.get(3)?,
                        state: row.get(4)?,
                        updated_at_ms: row.get::<_, i64>(5)? as u64,
                    })
                },
            )
            .optional()
            .map_err(map_database_error)
    }

    /// Removes the private session binding (archive/retention cleanup).
    pub fn delete_conversation_session(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
    ) -> Result<(), StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, owner_device_id, conversation_id)?;
        transaction
            .execute(
                "DELETE FROM conversation_sessions WHERE conversation_id=?1",
                params![conversation_id],
            )
            .map_err(map_database_error)?;
        transaction.commit().map_err(map_database_error)
    }

    /// Marks a conversation unavailable without changing its durable
    /// transcript. This is used when project access or native Pi resume is no
    /// longer safe; future appends must fail closed until the gateway repairs
    /// the binding.
    pub fn mark_conversation_unavailable(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
        at_ms: u64,
        at: &str,
        event_id: &str,
    ) -> Result<bool, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        validate_key(event_id)?;
        if at.is_empty() {
            return Err(StorageError::InvalidKey);
        }
        let error = RemoteConversationError {
            code: RemoteConversationErrorCode::SessionResumeUnavailable,
            message: "conversation runtime is unavailable".to_owned(),
            retryable: false,
        };
        let _ = self.fail_queued_turns(owner_device_id, conversation_id, &error, at_ms, at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, owner_device_id, conversation_id)?;
        let previous = parse_conversation_status(&conversation_status_column(
            &transaction,
            owner_device_id,
            conversation_id,
        )?)?;
        if previous == RemoteConversationStatus::Archived
            || previous == RemoteConversationStatus::Unavailable
        {
            transaction.commit().map_err(map_database_error)?;
            return Ok(false);
        }
        transaction
            .execute(
                "UPDATE conversations SET status='unavailable', updated_at_ms=?1
                 WHERE owner_device_id=?2 AND conversation_id=?3",
                params![at_ms as i64, owner_device_id, conversation_id],
            )
            .map_err(map_database_error)?;
        let sequence = next_raw_event_sequence(&transaction, owner_device_id)?;
        insert_raw_conversation_event(
            &transaction,
            owner_device_id,
            sequence,
            event_id,
            at_ms,
            &status_changed_event(
                owner_device_id,
                conversation_id,
                event_id,
                at,
                sequence,
                &previous,
                &RemoteConversationStatus::Unavailable,
            ),
        )?;
        transaction.commit().map_err(map_database_error)?;
        Ok(true)
    }

    /// Archives a conversation and makes all remaining queued turns
    /// terminal. The private session binding is removed in this same
    /// transaction; filesystem material is removed by the runtime adapter.
    pub fn archive_conversation(
        &self,
        owner_device_id: &str,
        conversation_id: &str,
        at_ms: u64,
    ) -> Result<bool, StorageError> {
        validate_key(owner_device_id)?;
        validate_key(conversation_id)?;
        let error = RemoteConversationError {
            code: RemoteConversationErrorCode::Cancelled,
            message: "conversation archived".to_owned(),
            retryable: false,
        };
        let at = format_unix_ms(at_ms);
        let _ = self.fail_queued_turns(owner_device_id, conversation_id, &error, at_ms, &at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        owner_conversation_exists(&transaction, owner_device_id, conversation_id)?;
        let previous = parse_conversation_status(&conversation_status_column(
            &transaction,
            owner_device_id,
            conversation_id,
        )?)?;
        if previous == RemoteConversationStatus::Archived {
            transaction.commit().map_err(map_database_error)?;
            return Ok(false);
        }
        transaction
            .execute(
                "UPDATE conversations SET status='archived', archived_at_ms=?1,
                    updated_at_ms=?1 WHERE owner_device_id=?2 AND conversation_id=?3",
                params![at_ms as i64, owner_device_id, conversation_id],
            )
            .map_err(map_database_error)?;
        transaction
            .execute(
                "DELETE FROM conversation_sessions WHERE conversation_id=?1",
                params![conversation_id],
            )
            .map_err(map_database_error)?;
        transaction.commit().map_err(map_database_error)?;
        Ok(previous != RemoteConversationStatus::Archived)
    }

    pub fn commit_task_event_with_request(
        &self,
        snapshot: &RemoteTaskSnapshot,
        event: &StoredEvent,
        idempotency: Option<&IdempotencyRecord>,
        request: Option<&RemoteTaskCreateRequest>,
    ) -> Result<(), StorageError> {
        validate_event_metadata(event)?;
        let snapshot_json = serde_json::to_vec(snapshot).map_err(|_| StorageError::Database)?;
        let event_json = serde_json::to_vec(&event.payload).map_err(|_| StorageError::Database)?;
        let request_json = request
            .map(|request| {
                request
                    .validate()
                    .map_err(|_| StorageError::Corrupt)
                    .and_then(|_| serde_json::to_vec(request).map_err(|_| StorageError::Database))
            })
            .transpose()?;
        if snapshot_json.len() > MAX_SNAPSHOT_BYTES
            || event_json.len() > MAX_EVENT_BYTES
            || request_json
                .as_ref()
                .is_some_and(|value| value.len() > MAX_REQUEST_BYTES)
        {
            return Err(StorageError::PayloadTooLarge);
        }
        validate_key(&event.device_id)?;
        validate_key(&event.event_id)?;
        let state = serde_json::to_value(&snapshot.state)
            .map_err(|_| StorageError::Database)?
            .as_str()
            .ok_or(StorageError::Database)?
            .to_owned();
        let now = now_ms();
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        transaction
            .execute(
                "INSERT INTO tasks(task_id, owner_device_id, project_id, state, snapshot_json, request_json, updated_at_ms)\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)\
                 ON CONFLICT(task_id) DO UPDATE SET owner_device_id=excluded.owner_device_id,\
                 project_id=excluded.project_id, state=excluded.state, snapshot_json=excluded.snapshot_json,\
                 request_json=COALESCE(excluded.request_json, tasks.request_json),\
                 updated_at_ms=excluded.updated_at_ms",
                params![
                    snapshot.task_id,
                    snapshot.owner_device_id,
                    snapshot.project_id,
                    state,
                    snapshot_json,
                    request_json,
                    now,
                ],
            )
            .map_err(map_database_error)?;
        transaction
            .execute(
                "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![event.device_id, event.sequence, event.event_id, event.emitted_at_ms, event_json],
            )
            .map_err(map_database_error)?;
        if let Some(idempotency) = idempotency {
            validate_key(&idempotency.device_id)?;
            validate_key(&idempotency.request_id)?;
            validate_key(&idempotency.task_id)?;
            let existing = transaction
                .query_row(
                    "SELECT task_id, fingerprint, expires_at_ms FROM idempotency WHERE device_id=?1 AND request_id=?2",
                    params![idempotency.device_id, idempotency.request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .optional()
                .map_err(map_database_error)?;
            match existing {
                Some((task_id, fingerprint, expires_at_ms))
                    if task_id != idempotency.task_id
                        || fingerprint as u64 != idempotency.fingerprint
                        || expires_at_ms as u64 != idempotency.expires_at_ms =>
                {
                    return Err(StorageError::IdempotencyConflict);
                }
                None => {
                    transaction
                        .execute(
                            "INSERT INTO idempotency(device_id, request_id, task_id, fingerprint, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![
                                idempotency.device_id,
                                idempotency.request_id,
                                idempotency.task_id,
                                i64::from_ne_bytes(idempotency.fingerprint.to_ne_bytes()),
                                idempotency.expires_at_ms as i64
                            ],
                        )
                        .map_err(map_database_error)?;
                }
                _ => {}
            }
        }
        retain_locked(&transaction, self.limits, now)?;
        transaction.commit().map_err(map_database_error)
    }

    pub fn upsert_device(&self, device: &StoredDevice) -> Result<(), StorageError> {
        validate_key(&device.device_id)?;
        validate_key(&device.display_name)?;
        validate_key(&device.platform)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "INSERT INTO devices(device_id, token_hash, display_name, platform, identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5)\
                 ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash, display_name=excluded.display_name, platform=excluded.platform, identity_epoch=excluded.identity_epoch",
                params![device.device_id, device.token_hash.as_slice(), device.display_name, device.platform, device.identity_epoch as i64],
            )
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn device(&self, device_id: &str) -> Result<Option<StoredDevice>, StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT token_hash, display_name, platform, identity_epoch FROM devices WHERE device_id=?1",
                params![device_id],
                |row| {
                    let hash: Vec<u8> = row.get(0)?;
                    let token_hash: [u8; 32] = hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?;
                    Ok(StoredDevice { device_id: device_id.to_owned(), token_hash, display_name: row.get(1)?, platform: row.get(2)?, identity_epoch: row.get::<_, i64>(3)? as u64 })
                },
            )
            .optional()
            .map_err(map_database_error)
    }

    pub fn list_devices(&self) -> Result<Vec<StoredDevice>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id, token_hash, display_name, platform, identity_epoch
                 FROM devices ORDER BY device_id ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                let hash: Vec<u8> = row.get(1)?;
                let token_hash: [u8; 32] =
                    hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(StoredDevice {
                    device_id: row.get(0)?,
                    token_hash,
                    display_name: row.get(2)?,
                    platform: row.get(3)?,
                    identity_epoch: row.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| row.map_err(map_database_error)).collect()
    }

    pub fn remove_device(&self, device_id: &str) -> Result<(), StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("DELETE FROM devices WHERE device_id=?1", params![device_id])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn clear_devices(&self) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("DELETE FROM devices", [])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn set_identity_epoch(&self, epoch: u64) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("INSERT INTO metadata(key, value) VALUES ('identity_epoch', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![epoch.to_string()])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn identity_epoch(&self) -> Result<u64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let value = connection
            .query_row(
                "SELECT value FROM metadata WHERE key='identity_epoch'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_database_error)?
            .unwrap_or_else(|| "0".into());
        value.parse().map_err(|_| StorageError::Corrupt)
    }

    pub fn load_non_terminal_tasks(&self) -> Result<Vec<RemoteTaskSnapshot>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT snapshot_json FROM tasks WHERE state IN ('queued','starting','running','awaiting_input') ORDER BY updated_at_ms ASC")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(map_database_error)?;
        rows.map(|row| {
            let bytes = row.map_err(map_database_error)?;
            serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)
        })
        .collect()
    }

    pub fn load_tasks(&self) -> Result<Vec<StoredTask>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT snapshot_json, request_json FROM tasks
                 ORDER BY updated_at_ms ASC, task_id ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                let snapshot =
                    serde_json::from_slice::<RemoteTaskSnapshot>(&row.get::<_, Vec<u8>>(0)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let request = row
                    .get::<_, Option<Vec<u8>>>(1)?
                    .map(|bytes| {
                        serde_json::from_slice::<RemoteTaskCreateRequest>(&bytes)
                            .map_err(|_| rusqlite::Error::InvalidQuery)
                    })
                    .transpose()?;
                Ok(StoredTask { snapshot, request })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let task = row.map_err(map_database_error)?;
            if let Some(request) = &task.request {
                request.validate().map_err(|_| StorageError::Corrupt)?;
                if request.project_id != task.snapshot.project_id
                    || request.request_id != task.snapshot.request_id
                    || request.context_files != task.snapshot.context_files
                    || request.request_id.is_empty()
                {
                    return Err(StorageError::Corrupt);
                }
            }
            Ok(task)
        })
        .collect()
    }

    pub fn load_idempotency(&self, now_ms: u64) -> Result<Vec<IdempotencyRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id, request_id, task_id, fingerprint, expires_at_ms
                 FROM idempotency
                 WHERE expires_at_ms > ?1
                   AND task_id IN (SELECT task_id FROM tasks)
                 ORDER BY expires_at_ms ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(params![now_ms as i64], |row| {
                let fingerprint = u64::from_ne_bytes(row.get::<_, i64>(3)?.to_ne_bytes());
                let expires_at_ms = u64::try_from(row.get::<_, i64>(4)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(IdempotencyRecord {
                    device_id: row.get(0)?,
                    request_id: row.get(1)?,
                    task_id: row.get(2)?,
                    fingerprint,
                    expires_at_ms,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let record = row.map_err(map_database_error)?;
            validate_key(&record.device_id)?;
            validate_key(&record.request_id)?;
            validate_key(&record.task_id)?;
            Ok(record)
        })
        .collect()
    }

    pub fn load_task(&self, task_id: &str) -> Result<Option<RemoteTaskSnapshot>, StorageError> {
        validate_key(task_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT snapshot_json FROM tasks WHERE task_id=?1",
                params![task_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(map_database_error)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt))
            .transpose()
    }

    pub fn load_events(
        &self,
        device_id: &str,
        after: Option<u64>,
    ) -> Result<Vec<StoredEvent>, StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, emitted_at_ms, event_json FROM events
                 WHERE device_id=?1
                   AND (?2 IS NULL OR sequence>?2)
                   AND json_extract(CAST(event_json AS TEXT), '$.conversationId') IS NULL
                   AND json_extract(CAST(event_json AS TEXT), '$.kind') IN (
                        'task.created',
                        'task.state_changed',
                        'task.output_appended',
                        'task.completed',
                        'task.changes',
                        'interaction.requested',
                        'interaction.resolved',
                        'interaction.expired',
                        'snapshot_required',
                        'event_backpressure'
                   )
                 ORDER BY sequence ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(params![device_id, after.map(|value| value as i64)], |row| {
                let sequence = row.get::<_, i64>(0)? as u64;
                let event_id = row.get::<_, String>(1)?;
                let emitted_at_ms = row.get::<_, i64>(2)? as u64;
                let payload = serde_json::from_slice::<RemoteEvent>(&row.get::<_, Vec<u8>>(3)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(StoredEvent {
                    device_id: device_id.to_owned(),
                    sequence,
                    event_id,
                    emitted_at_ms,
                    payload,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let event = row.map_err(map_database_error)?;
            validate_event_metadata(&event)?;
            Ok(event)
        })
        .collect()
    }

    /// Marks work that was in flight when the desktop disappeared as a
    /// terminal, non-retryable restart failure.  The snapshot and its
    /// completion event are committed together so a new process cannot
    /// expose stale running work without an authoritative terminal record.
    pub fn recover_non_terminal_tasks(
        &self,
        emitted_at_ms: u64,
        emitted_at: &str,
    ) -> Result<Vec<RemoteTaskSnapshot>, StorageError> {
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        let mut statement = transaction
            .prepare(
                "SELECT task_id, owner_device_id, snapshot_json FROM tasks
                 WHERE state IN ('queued','starting','running','awaiting_input')
                 ORDER BY updated_at_ms ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(map_database_error)?;
        let rows = rows
            .map(|row| row.map_err(map_database_error))
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut recovered = Vec::new();
        for row in rows {
            let (task_id, owner_device_id, bytes) = row;
            let mut snapshot: RemoteTaskSnapshot =
                serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)?;
            if snapshot.owner_device_id != owner_device_id || snapshot.task_id != task_id {
                return Err(StorageError::Corrupt);
            }
            let error = RemoteTaskError {
                code: RemoteTaskFailureCode::DesktopRestarted,
                message: "desktop restarted while the task was active".to_owned(),
                retryable: false,
            };
            snapshot.state = RemoteTaskState::Failed;
            snapshot.updated_at = emitted_at.to_owned();
            snapshot.finished_at = Some(emitted_at.to_owned());
            snapshot.error = Some(error.clone());
            let next_sequence = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE device_id=?1",
                    params![owner_device_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(map_database_error)? as u64;
            let event = RemoteEvent::TaskCompleted {
                base: RemoteEventBase {
                    event_id: format!("recovery-{task_id}-{emitted_at_ms}"),
                    emitted_at: emitted_at.to_owned(),
                    sequence: next_sequence,
                    device_id: owner_device_id.clone(),
                },
                task_id: task_id.clone(),
                state: RemoteTaskTerminalState::Failed,
                error: Some(error),
            };
            let snapshot_json =
                serde_json::to_vec(&snapshot).map_err(|_| StorageError::Database)?;
            let event_json = serde_json::to_vec(&event).map_err(|_| StorageError::Database)?;
            if snapshot_json.len() > MAX_SNAPSHOT_BYTES || event_json.len() > MAX_EVENT_BYTES {
                return Err(StorageError::PayloadTooLarge);
            }
            transaction
                .execute(
                    "UPDATE tasks SET state='failed', snapshot_json=?1, updated_at_ms=?2 WHERE task_id=?3",
                    params![snapshot_json, emitted_at_ms as i64, task_id],
                )
                .map_err(map_database_error)?;
            transaction
                .execute(
                    "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        owner_device_id,
                        next_sequence as i64,
                        format!("recovery-{task_id}-{emitted_at_ms}"),
                        emitted_at_ms as i64,
                        event_json
                    ],
                )
                .map_err(map_database_error)?;
            recovered.push(snapshot);
        }
        retain_locked(&transaction, self.limits, emitted_at_ms)?;
        transaction.commit().map_err(map_database_error)?;
        Ok(recovered)
    }

    pub fn counts(&self) -> Result<(usize, usize), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let tasks = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
            .map_err(map_database_error)? as usize;
        let events = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(map_database_error)? as usize;
        Ok((tasks, events))
    }

    pub fn event_cursors(&self) -> Result<Vec<(String, u64)>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT device_id, MAX(sequence) FROM events GROUP BY device_id")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let (device_id, sequence) = row.map_err(map_database_error)?;
            validate_key(&device_id)?;
            Ok((device_id, sequence))
        })
        .collect()
    }

    /// Upserts one remote-model allowlist entry. Returns
    /// `(remote_allowed, was_already_current)`.
    pub fn set_model_remote_allowed(
        &self,
        model_ref: &str,
        enabled: bool,
        at_ms: u64,
    ) -> Result<(bool, bool), StorageError> {
        validate_key(model_ref)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let changed = connection
            .execute(
                "INSERT INTO remote_model_allowlist(model_ref, allowed, updated_at_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(model_ref) DO UPDATE SET allowed=excluded.allowed, updated_at_ms=excluded.updated_at_ms
                 WHERE remote_model_allowlist.allowed != excluded.allowed",
                params![model_ref, i64::from(enabled), at_ms as i64],
            )
            .map_err(map_database_error)?;
        Ok((enabled, changed == 0))
    }

    /// Loads the whole allowlist as `(model_ref, allowed)` pairs.
    pub fn list_model_allowlist(&self) -> Result<Vec<(String, bool)>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT model_ref, allowed FROM remote_model_allowlist")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
            })
            .map_err(map_database_error)?;
        rows.map(|row| row.map_err(map_database_error)).collect()
    }

    /// Persists one model-admin grant. Returns `granted_now` (false when the
    /// grant was already in the requested state).
    pub fn set_model_admin_grant(
        &self,
        device_id: &str,
        granted: bool,
        at_ms: u64,
    ) -> Result<bool, StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        if granted {
            let changed = connection
                .execute(
                    "INSERT INTO device_model_admin(device_id, granted_at_ms)
                     VALUES (?1, ?2) ON CONFLICT(device_id) DO NOTHING",
                    params![device_id, at_ms as i64],
                )
                .map_err(map_database_error)?;
            Ok(changed > 0)
        } else {
            let changed = connection
                .execute(
                    "DELETE FROM device_model_admin WHERE device_id=?1",
                    params![device_id],
                )
                .map_err(map_database_error)?;
            Ok(changed > 0)
        }
    }

    /// Loads persisted model-admin grants as device ids.
    pub fn list_model_admin_grants(&self) -> Result<Vec<String>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT device_id FROM device_model_admin")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(map_database_error)?;
        rows.map(|row| row.map_err(map_database_error)).collect()
    }

    /// Appends one model-administration audit record (discover/add/enable/
    /// grant/revoke). Bounded retention keeps the table small; the newest
    /// records are the ones diagnostics surfaces.
    pub fn record_model_admin_audit(
        &self,
        audit_id: &str,
        operation: &str,
        device_id: &str,
        model_ref: Option<&str>,
        at_ms: u64,
    ) -> Result<(), StorageError> {
        validate_key(audit_id)?;
        validate_key(operation)?;
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "INSERT INTO model_admin_audit(audit_id, operation, device_id, model_ref, at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![audit_id, operation, device_id, model_ref, at_ms as i64],
            )
            .map_err(map_database_error)?;
        let _ = connection.execute(
            "DELETE FROM model_admin_audit WHERE audit_id NOT IN (
                SELECT audit_id FROM model_admin_audit ORDER BY at_ms DESC LIMIT 200
             )",
            [],
        );
        Ok(())
    }
}

fn configure_and_migrate(
    connection: &mut Connection,
    path: &Path,
    options: MigrationOptions,
) -> Result<(), StorageError> {
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(map_database_error)?;
    let existing_version = schema_version(connection)?;
    run_quick_check(connection)?;
    if options.failure_point == Some(MigrationFailurePoint::BeforeRestorePoint) {
        return Err(StorageError::RestorePoint);
    }
    if matches!(existing_version, Some(1 | 2)) {
        create_restore_point(connection, path, existing_version.unwrap())?;
    }
    if options.failure_point == Some(MigrationFailurePoint::AfterRestorePoint) {
        return Err(StorageError::Database);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_database_error)?;
    if existing_version.is_none() {
        create_v1_v2_schema(&transaction)?;
    }
    let version = schema_version_in_transaction(&transaction)?;
    match version {
        1 => migrate_v1_to_v2(&transaction)?,
        2 => {}
        3 => {
            migrate_v3_to_v4(&transaction)?;
            if options.failure_point == Some(MigrationFailurePoint::AfterV4Tables) {
                return Err(StorageError::Database);
            }
            transaction
                .execute(
                    "UPDATE metadata SET value=?1 WHERE key='schema_version'",
                    params![STORAGE_SCHEMA_VERSION.to_string()],
                )
                .map_err(map_database_error)?;
            transaction.commit().map_err(map_database_error)?;
            return Ok(());
        }
        4 => {
            transaction.commit().map_err(map_database_error)?;
            return Ok(());
        }
        version if version > STORAGE_SCHEMA_VERSION => {
            return Err(StorageError::DowngradeRefused {
                found: version,
                supported: STORAGE_SCHEMA_VERSION,
            });
        }
        version => return Err(StorageError::UnsupportedSchema(version)),
    }
    create_v3_schema(&transaction)?;
    if options.failure_point == Some(MigrationFailurePoint::AfterV3Tables) {
        return Err(StorageError::Database);
    }
    migrate_v3_to_v4(&transaction)?;
    if options.failure_point == Some(MigrationFailurePoint::AfterV4Tables) {
        return Err(StorageError::Database);
    }
    transaction
        .execute(
            "UPDATE metadata SET value=?1 WHERE key='schema_version'",
            params![STORAGE_SCHEMA_VERSION.to_string()],
        )
        .map_err(map_database_error)?;
    transaction.commit().map_err(map_database_error)
}

fn validate_conversation_acceptance(
    acceptance: &ConversationAcceptance,
) -> Result<(), StorageError> {
    validate_key(&acceptance.owner_device_id)?;
    validate_key(&acceptance.conversation_id)?;
    validate_key(&acceptance.turn_id)?;
    validate_key(&acceptance.request_id)?;
    validate_key(&acceptance.project_id)?;
    validate_key(&acceptance.user_message_id)?;
    validate_key(&acceptance.delivery_id)?;
    validate_key(&acceptance.request_fingerprint)?;
    validate_key(&acceptance.event_id)?;
    if acceptance.context_json.len() > MAX_REQUEST_BYTES
        || acceptance.prompt.len() > REMOTE_CONVERSATION_MAX_PROMPT_BYTES
        || acceptance.created_at.is_empty()
    {
        return Err(StorageError::PayloadTooLarge);
    }
    if let Some(model_ref) = &acceptance.model_ref {
        crate::conversation_protocol::validate_model_ref(model_ref)
            .map_err(|_| StorageError::InvalidKey)?;
    }
    Ok(())
}

fn validate_conversation_append_acceptance(
    acceptance: &ConversationAppendAcceptance,
) -> Result<(), StorageError> {
    validate_key(&acceptance.owner_device_id)?;
    validate_key(&acceptance.conversation_id)?;
    validate_key(&acceptance.turn_id)?;
    validate_key(&acceptance.request_id)?;
    validate_key(&acceptance.user_message_id)?;
    validate_key(&acceptance.delivery_id)?;
    validate_key(&acceptance.request_fingerprint)?;
    validate_key(&acceptance.event_id)?;
    if acceptance.context_json.len() > MAX_REQUEST_BYTES
        || acceptance.prompt.len() > REMOTE_CONVERSATION_MAX_PROMPT_BYTES
        || acceptance.created_at.is_empty()
    {
        return Err(StorageError::PayloadTooLarge);
    }
    if let Some(model_ref) = &acceptance.model_ref {
        crate::conversation_protocol::validate_model_ref(model_ref)
            .map_err(|_| StorageError::InvalidKey)?;
    }
    Ok(())
}

fn insert_turn_message_idempotency(
    transaction: &rusqlite::Transaction<'_>,
    owner_device_id: &str,
    conversation_id: &str,
    turn_id: &str,
    request_id: &str,
    user_message_id: &str,
    _delivery_id: &str,
    prompt: &str,
    context_json: &[u8],
    model_ref: Option<&str>,
    created_at_ms: u64,
    operation: &str,
    fingerprint: &str,
    expires_at_ms: u64,
    ordinal: u64,
) -> Result<(), StorageError> {
    transaction
        .execute(
            "INSERT INTO turns(turn_id, conversation_id, request_id, state, delivery_state, context_json, error_json, created_at_ms, started_at_ms, finished_at_ms, model_ref)
             VALUES (?1, ?2, ?3, 'queued', 'accepted', ?4, NULL, ?5, NULL, NULL, ?6)",
            params![
                turn_id,
                conversation_id,
                request_id,
                context_json,
                created_at_ms as i64,
                model_ref,
            ],
        )
        .map_err(map_database_error)?;
    transaction
        .execute(
            "INSERT INTO messages(message_id, conversation_id, turn_id, ordinal, role, status, content_blob, created_at_ms, completed_at_ms)
             VALUES (?1, ?2, ?3, ?4, 'user', 'accepted', ?5, ?6, NULL)",
            params![
                user_message_id,
                conversation_id,
                turn_id,
                ordinal as i64,
                prompt.as_bytes(),
                created_at_ms as i64
            ],
        )
        .map_err(map_database_error)?;
    transaction
        .execute(
            "INSERT INTO conversation_idempotency(owner_device_id, conversation_id, request_id, operation, result_ref, fingerprint, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                owner_device_id,
                conversation_id,
                request_id,
                operation,
                turn_id,
                fingerprint,
                expires_at_ms as i64
            ],
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn load_conversation_idempotency(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
    request_id: &str,
    operation: &str,
) -> Result<Option<(String, String)>, StorageError> {
    connection
        .query_row(
            "SELECT result_ref, fingerprint FROM conversation_idempotency
             WHERE owner_device_id=?1 AND conversation_id=?2 AND request_id=?3 AND operation=?4",
            params![owner_device_id, conversation_id, request_id, operation],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(map_database_error)
}

fn owner_conversation_exists(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<(), StorageError> {
    if owner_conversation_exists_optional(connection, owner_device_id, conversation_id)? {
        Ok(())
    } else {
        Err(StorageError::InvalidKey)
    }
}

fn owner_conversation_exists_optional(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<bool, StorageError> {
    connection
        .query_row(
            "SELECT 1 FROM conversations WHERE owner_device_id=?1 AND conversation_id=?2",
            params![owner_device_id, conversation_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(map_database_error)
}

fn next_message_ordinal(
    connection: &Connection,
    conversation_id: &str,
) -> Result<u64, StorageError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM messages WHERE conversation_id=?1",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value as u64)
        .map_err(map_database_error)
}

fn next_raw_event_sequence(
    connection: &Connection,
    owner_device_id: &str,
) -> Result<u64, StorageError> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE device_id=?1",
            params![owner_device_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value as u64)
        .map_err(map_database_error)
}

fn insert_raw_conversation_event(
    transaction: &rusqlite::Transaction<'_>,
    owner_device_id: &str,
    sequence: u64,
    event_id: &str,
    emitted_at_ms: u64,
    event: &RemoteConversationEvent,
) -> Result<(), StorageError> {
    validate_key(owner_device_id)?;
    validate_key(event_id)?;
    let bytes = serde_json::to_vec(event).map_err(|_| StorageError::Database)?;
    if bytes.len() > MAX_CONVERSATION_EVENT_BYTES {
        return Err(StorageError::PayloadTooLarge);
    }
    transaction
        .execute(
            "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                owner_device_id,
                sequence as i64,
                event_id,
                emitted_at_ms as i64,
                bytes
            ],
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn load_conversation_create_response_locked(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
    turn_id: &str,
    user_message_id: &str,
) -> Result<RemoteConversationCreateResponse, StorageError> {
    let conversation = load_conversation_snapshot(connection, owner_device_id, conversation_id)?;
    let turn = load_turn(connection, owner_device_id, conversation_id, turn_id)?;
    let user_message = load_message(connection, conversation_id, user_message_id)?;
    let delivery = load_delivery(connection, conversation_id, turn_id)?;
    Ok(RemoteConversationCreateResponse {
        conversation,
        turn,
        user_message,
        delivery,
    })
}

fn load_turn_append_response_locked(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
    turn_id: &str,
    user_message_id: &str,
    duplicate: bool,
) -> Result<RemoteTurnAppendResponse, StorageError> {
    let conversation = load_conversation_snapshot(connection, owner_device_id, conversation_id)?;
    let turn = load_turn(connection, owner_device_id, conversation_id, turn_id)?;
    let user_message = load_message(connection, conversation_id, user_message_id)?;
    let delivery = load_delivery(connection, conversation_id, turn_id)?;
    Ok(RemoteTurnAppendResponse {
        conversation,
        turn,
        user_message,
        delivery,
        duplicate,
    })
}

fn load_conversation_snapshot(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<RemoteConversationSnapshot, StorageError> {
    let (project_id, title, status, created_at_ms, updated_at_ms, archived_at_ms, default_model_ref) = connection
        .query_row(
            "SELECT project_id, title, status, created_at_ms, updated_at_ms, archived_at_ms, default_model_ref
             FROM conversations WHERE owner_device_id=?1 AND conversation_id=?2",
            params![owner_device_id, conversation_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(map_database_error)?;
    let latest_turn = load_latest_turn(connection, owner_device_id, conversation_id)?;
    let active_turn = match &latest_turn {
        Some(turn)
            if matches!(
                turn.state,
                RemoteTurnState::Queued
                    | RemoteTurnState::Starting
                    | RemoteTurnState::Running
                    | RemoteTurnState::AwaitingInput
            ) =>
        {
            Some(turn.clone())
        }
        _ => None,
    };
    let latest_message = load_latest_message(connection, conversation_id)?;
    let message_count = count_table_for_conversation(connection, "messages", conversation_id)?;
    let turn_count = count_table_for_conversation(connection, "turns", conversation_id)?;
    let queued_turn_count = connection
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE conversation_id=?1 AND state='queued'",
            params![conversation_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(map_database_error)? as u64;
    Ok(RemoteConversationSnapshot {
        version: REMOTE_CONVERSATION_PROTOCOL_VERSION,
        conversation_id: conversation_id.to_owned(),
        owner_device_id: owner_device_id.to_owned(),
        project_id,
        title,
        status: parse_conversation_status(&status)?,
        created_at: format_unix_ms(created_at_ms as u64),
        updated_at: format_unix_ms(updated_at_ms as u64),
        archived_at: archived_at_ms.map(|value| format_unix_ms(value as u64)),
        active_turn,
        latest_turn,
        latest_message,
        pending_interaction: None,
        message_count,
        turn_count,
        queued_turn_count,
        default_model_ref,
        capabilities: default_conversation_capabilities(),
    })
}

fn load_latest_turn(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<Option<RemoteTurnSnapshot>, StorageError> {
    let turn_id = connection
        .query_row(
            "SELECT turn_id FROM turns WHERE conversation_id=?1 ORDER BY created_at_ms DESC, turn_id DESC LIMIT 1",
            params![conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_database_error)?;
    turn_id
        .map(|turn_id| load_turn(connection, owner_device_id, conversation_id, &turn_id))
        .transpose()
}

fn load_turn(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
    turn_id: &str,
) -> Result<RemoteTurnSnapshot, StorageError> {
    let (request_id, state, delivery_state, error_json, created_at_ms, started_at_ms, finished_at_ms, model_ref) =
        connection
            .query_row(
                "SELECT request_id, state, delivery_state, error_json, created_at_ms, started_at_ms, finished_at_ms, model_ref
                 FROM turns WHERE conversation_id=?1 AND turn_id=?2",
                params![conversation_id, turn_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                    ))
                },
            )
            .map_err(map_database_error)?;
    let user_message_id = connection
        .query_row(
            "SELECT message_id FROM messages WHERE conversation_id=?1 AND turn_id=?2 AND role='user' ORDER BY ordinal ASC LIMIT 1",
            params![conversation_id, turn_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(map_database_error)?;
    let assistant_message_id = connection
        .query_row(
            "SELECT message_id FROM messages WHERE conversation_id=?1 AND turn_id=?2 AND role='assistant' ORDER BY ordinal DESC LIMIT 1",
            params![conversation_id, turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_database_error)?;
    let error = error_json
        .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt))
        .transpose()?;
    Ok(RemoteTurnSnapshot {
        turn_id: turn_id.to_owned(),
        conversation_id: conversation_id.to_owned(),
        request_id,
        owner_device_id: owner_device_id.to_owned(),
        state: parse_turn_state(&state)?,
        created_at: format_unix_ms(created_at_ms as u64),
        updated_at: format_unix_ms(created_at_ms as u64),
        started_at: started_at_ms.map(|value| format_unix_ms(value as u64)),
        finished_at: finished_at_ms.map(|value| format_unix_ms(value as u64)),
        user_message_id,
        assistant_message_id,
        pending_interaction_id: None,
        model_ref,
        delivery: Some(derive_delivery_snapshot(
            conversation_id,
            turn_id,
            &delivery_state,
            created_at_ms as u64,
            None,
            None,
            None,
        )?),
        error,
    })
}

fn load_message(
    connection: &Connection,
    conversation_id: &str,
    message_id: &str,
) -> Result<RemoteMessage, StorageError> {
    connection
        .query_row(
            "SELECT turn_id, role, status, content_blob, created_at_ms, completed_at_ms
             FROM messages WHERE conversation_id=?1 AND message_id=?2",
            params![conversation_id, message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .map_err(map_database_error)
        .and_then(
            |(turn_id, role, status, content, created_at_ms, completed_at_ms)| {
                Ok(RemoteMessage {
                    message_id: message_id.to_owned(),
                    conversation_id: conversation_id.to_owned(),
                    turn_id,
                    role: parse_message_role(&role)?,
                    status: parse_message_status(&status)?,
                    text: String::from_utf8(content).map_err(|_| StorageError::Corrupt)?,
                    created_at: format_unix_ms(created_at_ms as u64),
                    updated_at: format_unix_ms(created_at_ms as u64),
                    completed_at: completed_at_ms.map(|value| format_unix_ms(value as u64)),
                    error: None,
                })
            },
        )
}

fn load_latest_message(
    connection: &Connection,
    conversation_id: &str,
) -> Result<Option<RemoteMessage>, StorageError> {
    let message_id = connection
        .query_row(
            "SELECT message_id FROM messages WHERE conversation_id=?1 ORDER BY ordinal DESC LIMIT 1",
            params![conversation_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_database_error)?;
    message_id
        .map(|message_id| load_message(connection, conversation_id, &message_id))
        .transpose()
}

fn load_messages_after(
    connection: &Connection,
    conversation_id: &str,
    after_ordinal: u64,
    limit: usize,
) -> Result<Vec<(u64, RemoteMessage)>, StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT ordinal, message_id FROM messages
             WHERE conversation_id=?1 AND ordinal>?2
             ORDER BY ordinal ASC LIMIT ?3",
        )
        .map_err(map_database_error)?;
    let rows = statement
        .query_map(
            params![conversation_id, after_ordinal as i64, limit as i64],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?)),
        )
        .map_err(map_database_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(map_database_error)?;
    rows.into_iter()
        .map(|(ordinal, message_id)| {
            load_message(connection, conversation_id, &message_id).map(|message| (ordinal, message))
        })
        .collect()
}

fn load_delivery(
    connection: &Connection,
    conversation_id: &str,
    turn_id: &str,
) -> Result<RemoteDeliverySnapshot, StorageError> {
    let (status, created_at_ms) = connection
        .query_row(
            "SELECT delivery_state, created_at_ms FROM turns WHERE conversation_id=?1 AND turn_id=?2",
            params![conversation_id, turn_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(map_database_error)?;
    derive_delivery_snapshot(
        conversation_id,
        turn_id,
        &status,
        created_at_ms as u64,
        None,
        None,
        None,
    )
}

fn derive_delivery_snapshot(
    conversation_id: &str,
    turn_id: &str,
    status: &str,
    accepted_at_ms: u64,
    delivered_at_ms: Option<u64>,
    failed_at_ms: Option<u64>,
    error: Option<crate::conversation_protocol::RemoteConversationError>,
) -> Result<RemoteDeliverySnapshot, StorageError> {
    Ok(RemoteDeliverySnapshot {
        delivery_id: format!("{turn_id}:delivery"),
        conversation_id: conversation_id.to_owned(),
        turn_id: turn_id.to_owned(),
        status: parse_delivery_state(status)?,
        accepted_at: format_unix_ms(accepted_at_ms),
        delivered_at: delivered_at_ms.map(format_unix_ms),
        failed_at: failed_at_ms.map(format_unix_ms),
        error,
    })
}

fn count_table_for_conversation(
    connection: &Connection,
    table: &str,
    conversation_id: &str,
) -> Result<u64, StorageError> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE conversation_id=?1");
    connection
        .query_row(&sql, params![conversation_id], |row| row.get::<_, i64>(0))
        .map(|value| value as u64)
        .map_err(map_database_error)
}

fn parse_conversation_status(value: &str) -> Result<RemoteConversationStatus, StorageError> {
    match value {
        "idle" => Ok(RemoteConversationStatus::Idle),
        "queued" => Ok(RemoteConversationStatus::Queued),
        "starting" => Ok(RemoteConversationStatus::Starting),
        "running" => Ok(RemoteConversationStatus::Running),
        "awaiting_input" => Ok(RemoteConversationStatus::AwaitingInput),
        "interrupted" => Ok(RemoteConversationStatus::Interrupted),
        "archived" => Ok(RemoteConversationStatus::Archived),
        "unavailable" => Ok(RemoteConversationStatus::Unavailable),
        _ => Err(StorageError::Corrupt),
    }
}

fn parse_turn_state(value: &str) -> Result<RemoteTurnState, StorageError> {
    match value {
        "queued" => Ok(RemoteTurnState::Queued),
        "starting" => Ok(RemoteTurnState::Starting),
        "running" => Ok(RemoteTurnState::Running),
        "awaiting_input" => Ok(RemoteTurnState::AwaitingInput),
        "succeeded" => Ok(RemoteTurnState::Succeeded),
        "failed" => Ok(RemoteTurnState::Failed),
        "cancelled" => Ok(RemoteTurnState::Cancelled),
        _ => Err(StorageError::Corrupt),
    }
}

fn parse_delivery_state(value: &str) -> Result<RemoteTurnDeliveryState, StorageError> {
    match value {
        "accepted" => Ok(RemoteTurnDeliveryState::Accepted),
        "delivered" => Ok(RemoteTurnDeliveryState::Delivered),
        "failed" => Ok(RemoteTurnDeliveryState::Failed),
        _ => Err(StorageError::Corrupt),
    }
}

fn parse_message_role(value: &str) -> Result<RemoteMessageRole, StorageError> {
    match value {
        "user" => Ok(RemoteMessageRole::User),
        "assistant" => Ok(RemoteMessageRole::Assistant),
        "system" => Ok(RemoteMessageRole::System),
        _ => Err(StorageError::Corrupt),
    }
}

fn parse_message_status(value: &str) -> Result<RemoteMessageStatus, StorageError> {
    match value {
        "accepted" => Ok(RemoteMessageStatus::Accepted),
        "streaming" => Ok(RemoteMessageStatus::Streaming),
        "completed" => Ok(RemoteMessageStatus::Completed),
        "failed" => Ok(RemoteMessageStatus::Failed),
        "cancelled" => Ok(RemoteMessageStatus::Cancelled),
        _ => Err(StorageError::Corrupt),
    }
}

fn default_conversation_capabilities() -> RemoteConversationCapabilities {
    RemoteConversationCapabilities {
        conversation_v2: true,
        pi_session_resume: true,
        append_turns: true,
        cancel_turn: true,
        interactions: true,
        message_paging: true,
        event_replay: true,
        model_catalog: true,
        max_queued_turns: REMOTE_CONVERSATION_MAX_QUEUED_TURNS,
        max_prompt_bytes: REMOTE_CONVERSATION_MAX_PROMPT_BYTES,
        max_context_files: REMOTE_CONVERSATION_MAX_CONTEXT_FILES,
        max_page_size: REMOTE_CONVERSATION_MAX_PAGE_SIZE,
    }
}

/// Storage-owned snapshots must render timestamps with the crate-wide
/// ISO-8601 convention; contracts type every timestamp as `IsoTimestamp`.
fn format_unix_ms(ms: u64) -> String {
    crate::task_manager::format_timestamp(ms)
}

fn validate_turn_execution_input(input: &TurnExecutionInput) -> Result<(), StorageError> {
    validate_key(&input.owner_device_id)?;
    validate_key(&input.conversation_id)?;
    validate_key(&input.turn_id)?;
    validate_key(&input.event_id)?;
    if input.at.is_empty() {
        return Err(StorageError::InvalidKey);
    }
    Ok(())
}

fn validate_turn_completion_input(input: &TurnCompletionInput) -> Result<(), StorageError> {
    validate_key(&input.owner_device_id)?;
    validate_key(&input.conversation_id)?;
    validate_key(&input.turn_id)?;
    validate_key(&input.state_changed_event_id)?;
    validate_key(&input.completed_event_id)?;
    validate_key(&input.message_completed_event_id)?;
    validate_key(&input.status_changed_event_id)?;
    if input.at.is_empty() {
        return Err(StorageError::InvalidKey);
    }
    match (&input.assistant_message_id, &input.assistant_text) {
        (Some(message_id), Some(text)) => {
            validate_key(message_id)?;
            if text.is_empty() {
                return Err(StorageError::InvalidKey);
            }
        }
        (None, None) => {
            if input.terminal == RemoteTurnTerminalState::Succeeded {
                return Err(StorageError::InvalidKey);
            }
        }
        _ => return Err(StorageError::InvalidKey),
    }
    Ok(())
}

fn validate_conversation_session_record(
    record: &ConversationSessionRecord,
) -> Result<(), StorageError> {
    validate_key(&record.owner_device_id)?;
    validate_key(&record.conversation_id)?;
    validate_key(&record.session_id)?;
    validate_key(&record.relative_ref)?;
    validate_key(&record.pi_version)?;
    validate_key(&record.format_fingerprint)?;
    validate_key(&record.state)?;
    Ok(())
}

fn terminal_to_turn_state(terminal: &RemoteTurnTerminalState) -> RemoteTurnState {
    match terminal {
        RemoteTurnTerminalState::Succeeded => RemoteTurnState::Succeeded,
        RemoteTurnTerminalState::Failed => RemoteTurnState::Failed,
        RemoteTurnTerminalState::Cancelled => RemoteTurnState::Cancelled,
    }
}

fn turn_state_to_db(state: &RemoteTurnState) -> &'static str {
    match state {
        RemoteTurnState::Queued => "queued",
        RemoteTurnState::Starting => "starting",
        RemoteTurnState::Running => "running",
        RemoteTurnState::AwaitingInput => "awaiting_input",
        RemoteTurnState::Succeeded => "succeeded",
        RemoteTurnState::Failed => "failed",
        RemoteTurnState::Cancelled => "cancelled",
    }
}

fn conversation_status_to_db(status: &RemoteConversationStatus) -> &'static str {
    match status {
        RemoteConversationStatus::Idle => "idle",
        RemoteConversationStatus::Queued => "queued",
        RemoteConversationStatus::Starting => "starting",
        RemoteConversationStatus::Running => "running",
        RemoteConversationStatus::AwaitingInput => "awaiting_input",
        RemoteConversationStatus::Interrupted => "interrupted",
        RemoteConversationStatus::Archived => "archived",
        RemoteConversationStatus::Unavailable => "unavailable",
    }
}

fn message_status_to_db(status: &RemoteMessageStatus) -> &'static str {
    match status {
        RemoteMessageStatus::Accepted => "accepted",
        RemoteMessageStatus::Streaming => "streaming",
        RemoteMessageStatus::Completed => "completed",
        RemoteMessageStatus::Failed => "failed",
        RemoteMessageStatus::Cancelled => "cancelled",
    }
}

fn conversation_status_column(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<String, StorageError> {
    connection
        .query_row(
            "SELECT status FROM conversations WHERE owner_device_id=?1 AND conversation_id=?2",
            params![owner_device_id, conversation_id],
            |row| row.get(0),
        )
        .map_err(map_database_error)
}

fn conversation_event_base(
    event_id: &str,
    emitted_at: &str,
    sequence: u64,
    device_id: &str,
    conversation_id: &str,
) -> RemoteConversationEventBase {
    RemoteConversationEventBase {
        event_id: event_id.to_owned(),
        emitted_at: emitted_at.to_owned(),
        sequence,
        device_id: device_id.to_owned(),
        conversation_id: conversation_id.to_owned(),
    }
}

#[allow(clippy::too_many_arguments)]
fn turn_state_changed_event(
    owner_device_id: &str,
    conversation_id: &str,
    event_id: &str,
    emitted_at: &str,
    sequence: u64,
    turn_id: &str,
    from: &RemoteTurnState,
    to: &RemoteTurnState,
    error: Option<RemoteConversationError>,
) -> RemoteConversationEvent {
    RemoteConversationEvent::TurnStateChanged(RemoteTurnStateChangedEvent {
        base: conversation_event_base(
            event_id,
            emitted_at,
            sequence,
            owner_device_id,
            conversation_id,
        ),
        turn_id: turn_id.to_owned(),
        from: from.clone(),
        to: to.clone(),
        error,
    })
}

fn status_changed_event(
    owner_device_id: &str,
    conversation_id: &str,
    event_id: &str,
    emitted_at: &str,
    sequence: u64,
    from: &RemoteConversationStatus,
    to: &RemoteConversationStatus,
) -> RemoteConversationEvent {
    RemoteConversationEvent::ConversationStatusChanged(RemoteConversationStatusChangedEvent {
        base: conversation_event_base(
            event_id,
            emitted_at,
            sequence,
            owner_device_id,
            conversation_id,
        ),
        from: from.clone(),
        to: to.clone(),
    })
}

/// Applies one turn state transition inside an open transaction: enforces
/// the contract state machine, updates timestamps/error/delivery, refreshes
/// the derived conversation status, and reports what changed so the caller
/// can emit the matching semantic events.
fn apply_turn_transition(
    transaction: &rusqlite::Transaction<'_>,
    owner_device_id: &str,
    conversation_id: &str,
    turn_id: &str,
    to_state: &RemoteTurnState,
    error: Option<&RemoteConversationError>,
    at_ms: u64,
    delivery_update: Option<&str>,
) -> Result<
    (
        RemoteTurnState,
        RemoteConversationStatus,
        RemoteConversationStatus,
    ),
    StorageError,
> {
    let from_state = parse_turn_state(&turn_state_column(transaction, conversation_id, turn_id)?)?;
    if !can_transition_remote_turn(&from_state, to_state) {
        return Err(StorageError::InvalidTransition);
    }
    if matches!(to_state, RemoteTurnState::Starting) {
        transaction
            .execute(
                "UPDATE turns SET state=?1, started_at_ms=COALESCE(started_at_ms, ?2)
                 WHERE conversation_id=?3 AND turn_id=?4",
                params![
                    turn_state_to_db(to_state),
                    at_ms as i64,
                    conversation_id,
                    turn_id
                ],
            )
            .map_err(map_database_error)?;
    } else if is_remote_turn_terminal_state(to_state) {
        let error_json = error
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| StorageError::Database)?;
        transaction
            .execute(
                "UPDATE turns SET state=?1, finished_at_ms=?2, error_json=?3
                 WHERE conversation_id=?4 AND turn_id=?5",
                params![
                    turn_state_to_db(to_state),
                    at_ms as i64,
                    error_json,
                    conversation_id,
                    turn_id
                ],
            )
            .map_err(map_database_error)?;
    } else {
        transaction
            .execute(
                "UPDATE turns SET state=?1 WHERE conversation_id=?2 AND turn_id=?3",
                params![turn_state_to_db(to_state), conversation_id, turn_id],
            )
            .map_err(map_database_error)?;
    }
    if let Some(delivery_state) = delivery_update {
        transaction
            .execute(
                "UPDATE turns SET delivery_state=?1 WHERE conversation_id=?2 AND turn_id=?3",
                params![delivery_state, conversation_id, turn_id],
            )
            .map_err(map_database_error)?;
    }
    transaction
        .execute(
            "UPDATE conversations SET updated_at_ms=?1 WHERE conversation_id=?2",
            params![at_ms as i64, conversation_id],
        )
        .map_err(map_database_error)?;
    let prev_status = parse_conversation_status(&conversation_status_column(
        transaction,
        owner_device_id,
        conversation_id,
    )?)?;
    let new_status =
        derive_conversation_status_locked(transaction, owner_device_id, conversation_id)?;
    if new_status != prev_status {
        transaction
            .execute(
                "UPDATE conversations SET status=?1 WHERE conversation_id=?2",
                params![conversation_status_to_db(&new_status), conversation_id],
            )
            .map_err(map_database_error)?;
    }
    Ok((from_state, prev_status, new_status))
}

fn turn_state_column(
    connection: &Connection,
    conversation_id: &str,
    turn_id: &str,
) -> Result<String, StorageError> {
    connection
        .query_row(
            "SELECT state FROM turns WHERE conversation_id=?1 AND turn_id=?2",
            params![conversation_id, turn_id],
            |row| row.get(0),
        )
        .map_err(map_database_error)
}

/// Recomputes the conversation status from persisted truth (archived flag
/// plus latest/active turn) using the contract derivation rules.
fn derive_conversation_status_locked(
    connection: &Connection,
    owner_device_id: &str,
    conversation_id: &str,
) -> Result<RemoteConversationStatus, StorageError> {
    let archived_at_ms: Option<i64> = connection
        .query_row(
            "SELECT archived_at_ms FROM conversations
             WHERE owner_device_id=?1 AND conversation_id=?2",
            params![owner_device_id, conversation_id],
            |row| row.get(0),
        )
        .map_err(map_database_error)?;
    let stored_status = parse_conversation_status(&conversation_status_column(
        connection,
        owner_device_id,
        conversation_id,
    )?)?;
    if matches!(
        stored_status,
        RemoteConversationStatus::Archived | RemoteConversationStatus::Unavailable
    ) {
        return Ok(stored_status);
    }
    let latest_turn = load_latest_turn(connection, owner_device_id, conversation_id)?;
    let active_turn = match &latest_turn {
        Some(turn) if !is_remote_turn_terminal_state(&turn.state) => Some(turn.clone()),
        _ => None,
    };
    let archived_at = archived_at_ms.map(|value| format_unix_ms(value as u64));
    Ok(derive_remote_conversation_status(
        archived_at.as_deref(),
        active_turn.as_ref(),
        latest_turn.as_ref(),
    ))
}

fn create_v1_v2_schema(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY NOT NULL, token_hash BLOB NOT NULL, display_name TEXT NOT NULL, platform TEXT NOT NULL, identity_epoch INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_json BLOB NOT NULL, request_json BLOB, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS idempotency(device_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, request_id));
             CREATE TABLE IF NOT EXISTS events(device_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT PRIMARY KEY NOT NULL, emitted_at_ms INTEGER NOT NULL, event_json BLOB NOT NULL, UNIQUE(device_id, sequence));
             CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at_ms);
             CREATE INDEX IF NOT EXISTS idx_events_emitted ON events(emitted_at_ms);
             INSERT INTO metadata(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO NOTHING;
             INSERT INTO metadata(key, value) VALUES ('identity_epoch', '0') ON CONFLICT(key) DO NOTHING;",
        )
        .map_err(map_database_error)
}

fn migrate_v1_to_v2(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    let has_request_column = transaction
        .prepare("PRAGMA table_info(tasks)")
        .map_err(map_database_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(map_database_error)?
        .any(|column| column.map(|name| name == "request_json").unwrap_or(false));
    if !has_request_column {
        transaction
            .execute("ALTER TABLE tasks ADD COLUMN request_json BLOB", [])
            .map_err(map_database_error)?;
    }
    transaction
        .execute(
            "UPDATE metadata SET value='2' WHERE key='schema_version'",
            [],
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn create_v3_schema(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    transaction
        .execute_batch(
            "CREATE TABLE conversations(
                conversation_id TEXT PRIMARY KEY NOT NULL,
                owner_device_id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                title TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                archived_at_ms INTEGER,
                default_model_ref TEXT
             );
             CREATE TABLE conversation_sessions(
                conversation_id TEXT PRIMARY KEY NOT NULL,
                session_id TEXT NOT NULL,
                relative_ref TEXT NOT NULL,
                pi_version TEXT NOT NULL,
                format_fingerprint TEXT NOT NULL,
                state TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
             );
             CREATE TABLE turns(
                turn_id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                state TEXT NOT NULL,
                delivery_state TEXT NOT NULL,
                context_json BLOB NOT NULL,
                error_json BLOB,
                created_at_ms INTEGER NOT NULL,
                started_at_ms INTEGER,
                finished_at_ms INTEGER,
                model_ref TEXT,
                UNIQUE(conversation_id, request_id),
                FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
             );
             CREATE TABLE messages(
                message_id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                role TEXT NOT NULL,
                status TEXT NOT NULL,
                content_blob BLOB NOT NULL,
                created_at_ms INTEGER NOT NULL,
                completed_at_ms INTEGER,
                UNIQUE(conversation_id, ordinal),
                FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
             );
             CREATE TABLE conversation_interactions(
                interaction_id TEXT PRIMARY KEY NOT NULL,
                conversation_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                status TEXT NOT NULL,
                snapshot_json BLOB NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
                FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE
             );
             CREATE TABLE conversation_idempotency(
                owner_device_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                result_ref TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                PRIMARY KEY(owner_device_id, conversation_id, request_id, operation),
                FOREIGN KEY(conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
             );
             CREATE INDEX idx_conversations_owner_updated ON conversations(owner_device_id, updated_at_ms DESC);
             CREATE INDEX idx_conversations_project ON conversations(project_id);
             CREATE INDEX idx_turns_conversation_created ON turns(conversation_id, created_at_ms);
             CREATE INDEX idx_turns_delivery_state ON turns(delivery_state, created_at_ms);
             CREATE INDEX idx_messages_conversation_ordinal ON messages(conversation_id, ordinal);
             CREATE INDEX idx_conversation_interactions_turn ON conversation_interactions(turn_id);
             CREATE INDEX idx_conversation_idempotency_expires ON conversation_idempotency(expires_at_ms);
             CREATE TABLE remote_model_allowlist(
                model_ref TEXT PRIMARY KEY NOT NULL,
                allowed INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE device_model_admin(
                device_id TEXT PRIMARY KEY NOT NULL,
                granted_at_ms INTEGER NOT NULL
             );
             CREATE TABLE model_admin_audit(
                audit_id TEXT PRIMARY KEY NOT NULL,
                operation TEXT NOT NULL,
                device_id TEXT NOT NULL,
                model_ref TEXT,
                at_ms INTEGER NOT NULL
             );",
        )
        .map_err(map_database_error)
}

/// v3 -> v4: per-turn and conversation-default model refs plus the gateway
/// remote-model allowlist. Idempotent column guards keep this safe on fresh
/// databases that already carry the columns from [`create_v3_schema`].
fn migrate_v3_to_v4(transaction: &rusqlite::Transaction<'_>) -> Result<(), StorageError> {
    for (table, column) in [
        ("conversations", "default_model_ref"),
        ("turns", "model_ref"),
    ] {
        let has_column = transaction
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(map_database_error)?
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(map_database_error)?
            .any(|column_name| column_name.map(|name| name == column).unwrap_or(false));
        if !has_column {
            transaction
                .execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"),
                    [],
                )
                .map_err(map_database_error)?;
        }
    }
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS remote_model_allowlist(
                model_ref TEXT PRIMARY KEY NOT NULL,
                allowed INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS device_model_admin(
                device_id TEXT PRIMARY KEY NOT NULL,
                granted_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS model_admin_audit(
                audit_id TEXT PRIMARY KEY NOT NULL,
                operation TEXT NOT NULL,
                device_id TEXT NOT NULL,
                model_ref TEXT,
                at_ms INTEGER NOT NULL
             );",
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn run_quick_check(connection: &Connection) -> Result<(), StorageError> {
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(map_database_error)?;
    if quick_check != "ok" {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn schema_version(connection: &Connection) -> Result<Option<i64>, StorageError> {
    let has_metadata: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='metadata'",
            [],
            |row| row.get(0),
        )
        .map_err(map_database_error)?;
    if has_metadata == 0 {
        return Ok(None);
    }
    let version = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(map_database_error)?
        .ok_or(StorageError::UnsupportedSchema(0))?;
    version
        .parse::<i64>()
        .map(Some)
        .map_err(|_| StorageError::UnsupportedSchema(0))
}

fn schema_version_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
) -> Result<i64, StorageError> {
    let version = transaction
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(map_database_error)?;
    version
        .parse::<i64>()
        .map_err(|_| StorageError::UnsupportedSchema(0))
}

fn create_restore_point(
    connection: &Connection,
    path: &Path,
    version: i64,
) -> Result<PathBuf, StorageError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(StorageError::RestorePoint)?;
    let restore_path = parent.join(format!("{file_name}.pre-v3-schema-v{version}.sqlite"));
    if restore_path.exists() {
        std::fs::remove_file(&restore_path).map_err(|_| StorageError::RestorePoint)?;
    }
    let restore_sql = format!("VACUUM INTO {}", quote_sql_string(&restore_path));
    connection
        .execute_batch(&restore_sql)
        .map_err(|_| StorageError::RestorePoint)?;
    Ok(restore_path)
}

fn quote_sql_string(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\'', "''");
    format!("'{value}'")
}

fn retain_locked(
    transaction: &rusqlite::Transaction<'_>,
    limits: StorageLimits,
    now: u64,
) -> Result<(), StorageError> {
    transaction
        .execute(
            "DELETE FROM events WHERE emitted_at_ms < ?1",
            params![now.saturating_sub(EVENT_RETENTION_MS) as i64],
        )
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY emitted_at_ms DESC, rowid DESC LIMIT ?1)", params![limits.max_events as i64])
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM tasks WHERE updated_at_ms < ?1 AND state IN ('succeeded','failed','cancelled')", params![now.saturating_sub(TASK_RETENTION_MS) as i64])
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM tasks WHERE rowid NOT IN (SELECT rowid FROM tasks ORDER BY updated_at_ms DESC, rowid DESC LIMIT ?1) AND state IN ('succeeded','failed','cancelled')", params![limits.max_tasks as i64])
        .map_err(map_database_error)?;
    transaction
        .execute(
            "DELETE FROM idempotency
             WHERE expires_at_ms <= ?1
                OR task_id NOT IN (SELECT task_id FROM tasks)",
            params![now as i64],
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn validate_key(value: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err(StorageError::InvalidKey)
    } else {
        Ok(())
    }
}

fn validate_event_metadata(event: &StoredEvent) -> Result<(), StorageError> {
    let (base_device_id, base_sequence, base_event_id) = match &event.payload {
        RemoteEvent::TaskCreated { base, .. }
        | RemoteEvent::TaskStateChanged { base, .. }
        | RemoteEvent::TaskOutputAppended { base, .. }
        | RemoteEvent::TaskCompleted { base, .. }
        | RemoteEvent::TaskChanges { base, .. }
        | RemoteEvent::InteractionRequested { base, .. }
        | RemoteEvent::InteractionResolved { base, .. }
        | RemoteEvent::InteractionExpired { base, .. }
        | RemoteEvent::SnapshotRequired { base, .. }
        | RemoteEvent::EventBackpressure { base, .. } => {
            (&base.device_id, base.sequence, &base.event_id)
        }
    };
    if base_device_id != &event.device_id
        || base_sequence != event.sequence
        || base_event_id != &event.event_id
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn map_database_error(error: rusqlite::Error) -> StorageError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::DatabaseCorrupt
                || error.code == rusqlite::ErrorCode::NotADatabase =>
        {
            StorageError::Corrupt
        }
        _ => StorageError::Database,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// FNV-1a deterministic id: replayed requests with the same material must
/// derive identical IDs so the storage idempotency lookup can hit.
pub(crate) fn deterministic_id(prefix: &str, material: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in material.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{prefix}-{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_bounded() {
        assert_eq!(
            StorageLimits {
                max_tasks: 0,
                max_events: usize::MAX
            }
            .bounded()
            .max_tasks,
            MAX_TASKS
        );
    }
}
