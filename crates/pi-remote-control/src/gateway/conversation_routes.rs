//! V2 conversation routes.
//!
//! Owner-scoped REST surface for durable conversations: create/list/snapshot,
//! paged transcripts, append with queue-capacity and interaction-pending
//! gates, idempotent cancel, capability advertisement, and semantic event
//! replay. All routes fail closed (503) until storage schema v3 and the
//! probe-proven conversation runtime are both wired. V1 routes are untouched.

use super::auth::authenticate_headers;
use super::errors::{request_id, GatewayError, GatewayErrorResponse};
use super::routes::{BoundedJson, GatewayState};
use crate::conversation_protocol::{
    RemoteConversationCapabilities, RemoteConversationCreateRequest,
    RemoteConversationCreateResponse, RemoteConversationEvent, RemoteConversationListResponse,
    RemoteConversationSnapshot, RemoteConversationStatus, RemoteConversationSummary,
    RemoteMessagePageResponse, RemoteTurnAppendRequest, RemoteTurnAppendResponse,
    RemoteTurnCancelRequest, RemoteTurnCancelResponse, validate_model_ref,
    REMOTE_CONVERSATION_MAX_CONTEXT_FILES, REMOTE_CONVERSATION_MAX_PAGE_SIZE,
    REMOTE_CONVERSATION_MAX_PROMPT_BYTES, REMOTE_CONVERSATION_MAX_QUEUED_TURNS,
};
use crate::models::{
    HostModelCatalog, ModelAllowlist, ModelCatalogError, RemoteModelAddRequest,
    RemoteModelAddResponse, RemoteModelCatalogResponse, RemoteModelDiscoverRequest,
    RemoteModelDiscoverResponse, RemoteModelEnableRequest, RemoteModelEnableResponse,
};
use crate::storage::{
    ConversationAcceptance, ConversationAppendAcceptance, RemoteStorage, StorageError,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const CONVERSATION_LIST_LIMIT: usize = 50;
const EVENT_REPLAY_LIMIT: usize = 500;
const IDEMPOTENCY_TTL_MS: u64 = 24 * 60 * 60 * 1000;

/// V2 is advertised only when schema v3 storage and the probe-proven
/// runtime are both present. Anything less fails closed.
fn v2_gate<'a>(
    state: &'a GatewayState,
    rid: Option<String>,
) -> Result<&'a Arc<RemoteStorage>, GatewayErrorResponse> {
    if state.storage.is_none() || state.conversations.is_none() {
        return Err(GatewayError::ServiceUnavailable.with_request_id(rid));
    }
    Ok(state.storage.as_ref().expect("checked above"))
}

fn map_storage_error(error: StorageError, rid: Option<String>) -> GatewayErrorResponse {
    let mapped = match error {
        StorageError::PayloadTooLarge => GatewayError::PayloadTooLarge,
        StorageError::IdempotencyConflict | StorageError::InvalidTransition => {
            GatewayError::Conflict
        }
        StorageError::QueueFull => GatewayError::QueueLimitReached,
        // Owner gates surface as InvalidKey; routes must stay
        // indistinguishable from not found.
        StorageError::InvalidKey => GatewayError::NotFound,
        StorageError::Corrupt
        | StorageError::Database
        | StorageError::UnsupportedSchema(_)
        | StorageError::DowngradeRefused { .. }
        | StorageError::RestorePoint => GatewayError::Internal,
    };
    mapped.with_request_id(rid)
}

pub(crate) use crate::storage::deterministic_id;

fn fingerprint<T: Serialize>(value: &T) -> Result<String, GatewayError> {
    serde_json::to_string(value).map_err(|_| GatewayError::Internal)
}

fn clock_now() -> (u64, String) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    (ms, crate::task_manager::format_timestamp(ms))
}

pub(super) fn v2_router() -> Router<Arc<GatewayState>> {
    Router::new()
        .route("/api/v2/capabilities", get(capabilities_v2))
        .route("/api/v2/diagnostics", get(diagnostics_v2))
        .route(
            "/api/v2/conversations",
            get(list_conversations).post(create_conversation),
        )
        .route(
            "/api/v2/conversations/:conversation_id",
            get(conversation_snapshot),
        )
        .route(
            "/api/v2/conversations/:conversation_id/messages",
            get(conversation_messages),
        )
        .route(
            "/api/v2/conversations/:conversation_id/turns",
            post(append_turn),
        )
        .route(
            "/api/v2/conversations/:conversation_id/archive",
            post(archive_conversation),
        )
        .route("/api/v2/turns/:turn_id/cancel", post(cancel_turn_route))
        .route("/api/v2/models", get(list_models).post(add_models))
        .route("/api/v2/models/discover", post(discover_models))
        .route(
            "/api/v2/models/:model_ref/remote-enable",
            post(enable_remote_model),
        )
        .route("/api/v2/events", get(events_v2))
        .route("/api/v2/events/stream", get(events_v2_stream))
}

/// Model routes fail closed (503) until the host injected a catalog.
fn model_gate<'a>(
    state: &'a GatewayState,
    rid: Option<String>,
) -> Result<&'a Arc<HostModelCatalog>, GatewayErrorResponse> {
    state
        .models
        .as_ref()
        .ok_or_else(|| GatewayError::ServiceUnavailable.with_request_id(rid))
}

fn load_allowlist(state: &GatewayState) -> Result<ModelAllowlist, GatewayErrorResponse> {
    let Some(storage) = state.storage.as_ref() else {
        return Err(GatewayError::ServiceUnavailable.with_request_id(None));
    };
    storage
        .list_model_allowlist()
        .map(ModelAllowlist::new)
        .map_err(|error| map_storage_error(error, None))
}

fn map_model_catalog_error(
    error: ModelCatalogError,
    rid: Option<String>,
) -> GatewayErrorResponse {
    let mapped = match error {
        ModelCatalogError::ProviderNotFound => GatewayError::NotFound,
        ModelCatalogError::InvalidFile | ModelCatalogError::InvalidPayload => {
            GatewayError::InvalidRequest
        }
        ModelCatalogError::TooLarge => GatewayError::PayloadTooLarge,
        ModelCatalogError::Unavailable => GatewayError::ServiceUnavailable,
    };
    mapped.with_request_id(rid)
}

/// Validates a conversation `modelRef` against the redacted catalog:
/// must exist, be available, and be remote-allowed. Fails closed when the
/// catalog is not wired.
fn validate_conversation_model_ref(
    state: &GatewayState,
    model_ref: Option<&str>,
    rid: Option<String>,
) -> Result<(), GatewayErrorResponse> {
    let Some(model_ref) = model_ref else {
        return Ok(());
    };
    validate_model_ref(model_ref).map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
    let catalog = model_gate(state, rid.clone())?;
    let allowlist = load_allowlist(state)?;
    let response = catalog
        .list(&allowlist)
        .map_err(|error| map_model_catalog_error(error, rid.clone()))?;
    let Some(entry) = response
        .models
        .iter()
        .find(|entry| entry.model_ref == model_ref)
    else {
        return Err(GatewayError::InvalidRequest.with_request_id(rid));
    };
    if !entry.available || !entry.remote_allowed {
        return Err(GatewayError::Forbidden.with_request_id(rid));
    }
    Ok(())
}

async fn capabilities_v2(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<RemoteConversationCapabilities>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    v2_gate(&state, rid.clone())?;
    Ok(Json(RemoteConversationCapabilities {
        conversation_v2: true,
        pi_session_resume: true,
        append_turns: true,
        cancel_turn: true,
        interactions: true,
        message_paging: true,
        event_replay: true,
        model_catalog: state.models.is_some(),
        max_queued_turns: REMOTE_CONVERSATION_MAX_QUEUED_TURNS,
        max_prompt_bytes: REMOTE_CONVERSATION_MAX_PROMPT_BYTES,
        max_context_files: REMOTE_CONVERSATION_MAX_CONTEXT_FILES,
        max_page_size: REMOTE_CONVERSATION_MAX_PAGE_SIZE,
    }))
}

#[derive(Debug, Serialize)]
struct V2DiagnosticsResponse {
    #[serde(rename = "activeConversations")]
    active_conversations: u64,
    #[serde(rename = "queuedTurns")]
    queued_turns: u64,
    #[serde(rename = "activeTurns")]
    active_turns: u64,
    #[serde(rename = "resumeSuccess")]
    resume_success: u64,
    #[serde(rename = "resumeFailure")]
    resume_failure: u64,
    #[serde(rename = "hostInterruptedTurns")]
    host_interrupted_turns: u64,
    #[serde(rename = "duplicateRequests")]
    duplicate_requests: u64,
    #[serde(rename = "droppedDeltas")]
    dropped_deltas: u64,
    #[serde(rename = "snapshotResyncs")]
    snapshot_resyncs: u64,
}

async fn diagnostics_v2(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<V2DiagnosticsResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    let counters = state.metrics.snapshot();
    Ok(Json(V2DiagnosticsResponse {
        active_conversations: storage
            .count_active_conversations()
            .map_err(|error| map_storage_error(error, rid.clone()))?,
        queued_turns: storage
            .count_queued_turns()
            .map_err(|error| map_storage_error(error, rid.clone()))?,
        active_turns: storage
            .count_active_turns()
            .map_err(|error| map_storage_error(error, rid))?,
        resume_success: counters.resume_success,
        resume_failure: counters.resume_failure,
        host_interrupted_turns: counters.host_interrupted_turns,
        duplicate_requests: counters.duplicate_requests,
        dropped_deltas: counters.dropped_deltas,
        snapshot_resyncs: counters.snapshot_resyncs,
    }))
}

async fn create_conversation(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteConversationCreateRequest>,
) -> Result<Json<RemoteConversationCreateResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    request
        .validate()
        .map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
    validate_conversation_model_ref(&state, request.model_ref.as_deref(), rid.clone())?;
    state
        .projects
        .project_summary(&request.project_id)
        .map_err(|_| GatewayError::NotFound.with_request_id(rid.clone()))?;
    for file in &request.context_files {
        state
            .projects
            .resolve_context_file(&request.project_id, &file.relative_path)
            .map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
    }
    let owner_device_id = authenticated.principal.device_id().to_owned();
    let create_material = format!("{owner_device_id}:{}", request.request_id);
    let conversation_id = deterministic_id("conv", &create_material);
    let turn_material = format!("{owner_device_id}:{conversation_id}:{}", request.request_id);
    let turn_id = deterministic_id("turn", &turn_material);
    let user_message_id = deterministic_id("msg", &turn_material);
    let delivery_id = deterministic_id("dlv", &turn_material);
    let event_id = deterministic_id("evt", &turn_material);
    let request_fingerprint = fingerprint(&request).map_err(|e| e.with_request_id(rid.clone()))?;
    let context_json = serde_json::to_vec(&request.context_files)
        .map_err(|_| GatewayError::Internal.with_request_id(rid.clone()))?;
    let (created_at_ms, created_at) = clock_now();
    let acceptance = ConversationAcceptance {
        owner_device_id,
        conversation_id,
        turn_id,
        request_id: request.request_id.clone(),
        project_id: request.project_id.clone(),
        title: None,
        user_message_id,
        delivery_id,
        prompt: request.prompt.clone(),
        context_json,
        model_ref: request.model_ref.clone(),
        created_at_ms,
        created_at,
        request_fingerprint,
        idempotency_expires_at_ms: created_at_ms + IDEMPOTENCY_TTL_MS,
        event_id,
    };
    let response = storage
        .create_conversation_turn(&acceptance)
        .map_err(|error| map_storage_error(error, rid))?;
    if response.delivery.status != crate::conversation_protocol::RemoteTurnDeliveryState::Accepted {
        state.metrics.inc_duplicate_requests();
    }
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    #[serde(default)]
    limit: Option<usize>,
}

async fn list_conversations(
    State(state): State<Arc<GatewayState>>,
    Query(query): Query<ListQuery>,
    headers: HeaderMap,
) -> Result<Json<RemoteConversationListResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    let limit = query
        .limit
        .unwrap_or(CONVERSATION_LIST_LIMIT)
        .min(CONVERSATION_LIST_LIMIT)
        .max(1);
    let snapshots = storage
        .list_conversations(authenticated.principal.device_id(), limit)
        .map_err(|error| map_storage_error(error, rid))?;
    let conversations = snapshots.into_iter().map(summary_from_snapshot).collect();
    Ok(Json(RemoteConversationListResponse {
        conversations,
        next_cursor: None,
    }))
}

fn summary_from_snapshot(snapshot: RemoteConversationSnapshot) -> RemoteConversationSummary {
    RemoteConversationSummary {
        conversation_id: snapshot.conversation_id,
        owner_device_id: snapshot.owner_device_id,
        project_id: snapshot.project_id,
        title: snapshot.title,
        status: snapshot.status,
        updated_at: snapshot.updated_at,
        latest_turn_state: snapshot.latest_turn.as_ref().map(|turn| turn.state.clone()),
        latest_message_preview: snapshot
            .latest_message
            .as_ref()
            .map(|message| message.text.chars().take(140).collect()),
        pending_interaction_id: snapshot
            .pending_interaction
            .as_ref()
            .map(|interaction| interaction.interaction_id.clone()),
        queued_turn_count: snapshot.queued_turn_count,
    }
}

async fn conversation_snapshot(
    State(state): State<Arc<GatewayState>>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RemoteConversationSnapshot>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    let snapshot = storage
        .load_conversation(authenticated.principal.device_id(), &conversation_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid))?;
    Ok(Json(snapshot))
}

#[derive(Debug, Deserialize)]
struct MessagesQuery {
    #[serde(default)]
    after: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn conversation_messages(
    State(state): State<Arc<GatewayState>>,
    Path(conversation_id): Path<String>,
    Query(query): Query<MessagesQuery>,
    headers: HeaderMap,
) -> Result<Json<RemoteMessagePageResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    let limit = query
        .limit
        .unwrap_or(REMOTE_CONVERSATION_MAX_PAGE_SIZE)
        .min(REMOTE_CONVERSATION_MAX_PAGE_SIZE)
        .max(1);
    let page = storage
        .load_conversation_messages(
            authenticated.principal.device_id(),
            &conversation_id,
            query.after,
            limit,
        )
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid))?;
    Ok(Json(page))
}

async fn append_turn(
    State(state): State<Arc<GatewayState>>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteTurnAppendRequest>,
) -> Result<Json<RemoteTurnAppendResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    request
        .validate()
        .map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
    validate_conversation_model_ref(&state, request.model_ref.as_deref(), rid.clone())?;
    let owner_device_id = authenticated.principal.device_id().to_owned();
    let snapshot = storage
        .load_conversation(&owner_device_id, &conversation_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid.clone()))?;
    // Ordinary send is rejected while an extension interaction is pending.
    if snapshot.status == RemoteConversationStatus::AwaitingInput {
        return Err(GatewayError::InteractionPending.with_request_id(rid));
    }
    // Archived conversations never accept new turns.
    if matches!(
        snapshot.status,
        RemoteConversationStatus::Archived | RemoteConversationStatus::Unavailable
    ) {
        return Err(GatewayError::Conflict.with_request_id(rid));
    }
    if let Some(context_files) = &request.context_files {
        for file in context_files {
            state
                .projects
                .resolve_context_file(&snapshot.project_id, &file.relative_path)
                .map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
        }
    }
    let turn_material = format!("{owner_device_id}:{conversation_id}:{}", request.request_id);
    let turn_id = deterministic_id("turn", &turn_material);
    let user_message_id = deterministic_id("msg", &turn_material);
    let delivery_id = deterministic_id("dlv", &turn_material);
    let event_id = deterministic_id("evt", &turn_material);
    let request_fingerprint = fingerprint(&request).map_err(|e| e.with_request_id(rid.clone()))?;
    let context_json = serde_json::to_vec(request.context_files.as_deref().unwrap_or(&[]))
        .map_err(|_| GatewayError::Internal.with_request_id(rid.clone()))?;
    let (created_at_ms, created_at) = clock_now();
    let acceptance = ConversationAppendAcceptance {
        owner_device_id,
        conversation_id,
        turn_id,
        request_id: request.request_id.clone(),
        user_message_id,
        delivery_id,
        prompt: request.prompt.clone(),
        context_json,
        model_ref: request.model_ref.clone(),
        created_at_ms,
        created_at,
        request_fingerprint,
        idempotency_expires_at_ms: created_at_ms + IDEMPOTENCY_TTL_MS,
        event_id,
    };
    let response = storage
        .append_conversation_turn(&acceptance)
        .map_err(|error| map_storage_error(error, rid))?;
    if response.duplicate {
        state.metrics.inc_duplicate_requests();
    }
    Ok(Json(response))
}

#[derive(Debug, Deserialize)]
struct ArchiveRequest {
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct ArchiveResponse {
    conversation: RemoteConversationSnapshot,
    duplicate: bool,
}

async fn archive_conversation(
    State(state): State<Arc<GatewayState>>,
    Path(conversation_id): Path<String>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<ArchiveRequest>,
) -> Result<Json<ArchiveResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    if let Some(request_id) = request.request_id.as_deref() {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(GatewayError::InvalidRequest.with_request_id(rid));
        }
    }
    let owner = authenticated.principal.device_id();
    let manager = state
        .conversations
        .as_ref()
        .expect("v2_gate guarantees the runtime is wired");
    let changed = manager.archive_conversation(owner, &conversation_id);
    let conversation = storage
        .load_conversation(owner, &conversation_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid))?;
    Ok(Json(ArchiveResponse {
        conversation,
        duplicate: !changed,
    }))
}

async fn cancel_turn_route(
    State(state): State<Arc<GatewayState>>,
    Path(turn_id): Path<String>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteTurnCancelRequest>,
) -> Result<Json<RemoteTurnCancelResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    if request.request_id.is_empty() {
        return Err(GatewayError::InvalidRequest.with_request_id(rid));
    }
    let owner_device_id = authenticated.principal.device_id().to_owned();
    let conversation_id = storage
        .conversation_for_turn(&owner_device_id, &turn_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid.clone()))?;
    let manager = state
        .conversations
        .as_ref()
        .expect("v2_gate guarantees the runtime is wired");
    let acted = manager.cancel_turn(&owner_device_id, &conversation_id, &turn_id);
    let conversation = storage
        .load_conversation(&owner_device_id, &conversation_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid.clone()))?;
    let turn = storage
        .load_turn_snapshot(&owner_device_id, &conversation_id, &turn_id)
        .map_err(|error| map_storage_error(error, rid.clone()))?
        .ok_or_else(|| GatewayError::NotFound.with_request_id(rid))?;
    Ok(Json(RemoteTurnCancelResponse {
        conversation,
        turn,
        duplicate: !acted,
    }))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after: Option<u64>,
}

#[derive(Debug, Serialize)]
struct ConversationEventsReplay {
    events: Vec<RemoteConversationEvent>,
    #[serde(rename = "snapshotRequired")]
    snapshot_required: bool,
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
}

async fn events_v2(
    State(state): State<Arc<GatewayState>>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<Json<ConversationEventsReplay>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = v2_gate(&state, rid.clone())?;
    let (stored, gap) = storage
        .load_conversation_events(
            authenticated.principal.device_id(),
            query.after,
            EVENT_REPLAY_LIMIT,
        )
        .map_err(|error| map_storage_error(error, rid))?;
    if gap {
        state.metrics.inc_snapshot_resyncs();
    }
    let next_cursor = stored.last().map(|event| event.sequence.to_string());
    let events = stored.into_iter().map(|event| event.payload).collect();
    Ok(Json(ConversationEventsReplay {
        events,
        snapshot_required: gap,
        next_cursor,
    }))
}

static NEXT_V2_STREAM_ID: AtomicU64 = AtomicU64::new(1);

/// Live v2 event stream. V2 events are persisted in the SQLite outbox rather
/// than the legacy in-memory EventHub, so this stream tails the same
/// owner-scoped durable sequence used by GET /api/v2/events. Reconnects pass
/// `after` and therefore have identical replay semantics to REST.
async fn events_v2_stream(
    ws: WebSocketUpgrade,
    State(state): State<Arc<GatewayState>>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let storage = Arc::clone(v2_gate(&state, rid)?);
    let device_id = authenticated.principal.device_id().to_owned();
    let connection_id = format!(
        "v2-ws-{}",
        NEXT_V2_STREAM_ID.fetch_add(1, Ordering::Relaxed)
    );
    state
        .devices
        .open_connection(&authenticated.principal, &connection_id)
        .map_err(|error| super::routes::map_connection_error(error, None))?;
    let cleanup_state = Arc::clone(&state);
    let cleanup_device = device_id.clone();
    let cleanup_connection = connection_id.clone();
    Ok(ws
        .on_failed_upgrade(move |_| {
            cleanup_state
                .devices
                .close_connection(&cleanup_device, &cleanup_connection);
        })
        .on_upgrade(move |socket| {
            conversation_websocket_session(
                socket,
                storage,
                device_id,
                connection_id,
                query.after,
                state,
            )
        }))
}

async fn conversation_websocket_session(
    mut socket: WebSocket,
    storage: Arc<RemoteStorage>,
    device_id: String,
    connection_id: String,
    after: Option<u64>,
    state: Arc<GatewayState>,
) {
    let mut cursor = after;
    loop {
        match storage.load_conversation_events(&device_id, cursor, EVENT_REPLAY_LIMIT) {
            Ok((events, gap)) => {
                if gap {
                    if let Some(stored) = events.first() {
                        let base = crate::conversation_protocol::event_base(&stored.payload);
                        let event = RemoteConversationEvent::SnapshotRequired(
                            crate::conversation_protocol::RemoteConversationSnapshotRequiredEvent {
                                base: crate::conversation_protocol::RemoteConversationEventBase {
                                    event_id: format!("v2-stream-gap-{}-{}", device_id, base.sequence),
                                    emitted_at: crate::task_manager::format_timestamp(now_ms()),
                                    sequence: base.sequence,
                                    device_id: device_id.clone(),
                                    conversation_id: base.conversation_id.clone(),
                                },
                                project_id: None,
                                reason: crate::conversation_protocol::RemoteConversationSnapshotRequiredReason::CursorExpired,
                            },
                        );
                        if send_conversation_event(&mut socket, &event).await.is_err() {
                            close_v2_stream(&state, &device_id, &connection_id);
                            return;
                        }
                        cursor = Some(
                            events
                                .last()
                                .map(|event| event.sequence)
                                .unwrap_or(base.sequence),
                        );
                        continue;
                    }
                }
                for stored in events {
                    cursor = Some(stored.sequence);
                    if send_conversation_event(&mut socket, &stored.payload)
                        .await
                        .is_err()
                    {
                        close_v2_stream(&state, &device_id, &connection_id);
                        return;
                    }
                }
            }
            Err(_) => {
                close_v2_stream(&state, &device_id, &connection_id);
                return;
            }
        }

        let mut last_activity = std::time::Instant::now();
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                // Half-open connections never deliver a close frame; the
                // idle deadline reclaims the connection budget so reconnect
                // does not stack 429s.
                if last_activity.elapsed() >= super::routes::WS_IDLE_TIMEOUT {
                    break;
                }
            },
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(payload))) => {
                        last_activity = std::time::Instant::now();
                        if socket.send(Message::Pong(payload)).await.is_err() { break; }
                    }
                    Some(Ok(Message::Pong(_))) | Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) => {
                        last_activity = std::time::Instant::now();
                    }
                }
            }
        }
    }
    close_v2_stream(&state, &device_id, &connection_id);
}

async fn send_conversation_event(
    socket: &mut WebSocket,
    event: &RemoteConversationEvent,
) -> Result<(), ()> {
    let payload = serde_json::to_string(event).map_err(|_| ())?;
    socket.send(Message::Text(payload)).await.map_err(|_| ())
}

fn close_v2_stream(state: &GatewayState, device_id: &str, connection_id: &str) {
    state.devices.close_connection(device_id, connection_id);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

async fn list_models(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<RemoteModelCatalogResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    let catalog = model_gate(&state, rid.clone())?;
    let allowlist = load_allowlist(&state)?;
    let response = catalog
        .list(&allowlist)
        .map_err(|error| map_model_catalog_error(error, rid))?;
    Ok(Json(response))
}

/// Sliding-window rate limit for elevated model-admin routes: 10 calls per
/// device per 60s. Bounded memory: entries are pruned when the window rolls.
fn model_admin_rate_limited(state: &GatewayState, device_id: &str) -> bool {
    const WINDOW_MS: u64 = 60_000;
    const MAX_CALLS: u32 = 10;
    let now = clock_now().0;
    let mut table = state
        .model_admin_rate
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let entry = table.entry(device_id.to_owned()).or_insert((0, 0));
    if now.saturating_sub(entry.0) >= WINDOW_MS {
        *entry = (now, 1);
        return false;
    }
    entry.1 += 1;
    if entry.1 > MAX_CALLS {
        if table.len() > 256 {
            table.retain(|_, (window, _)| now.saturating_sub(*window) < WINDOW_MS);
        }
        return true;
    }
    false
}

async fn discover_models(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteModelDiscoverRequest>,
) -> Result<Json<RemoteModelDiscoverResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    authenticated
        .principal
        .require(crate::principal::RemoteScope::ModelAdmin)
        .map_err(|_| GatewayError::Forbidden.with_request_id(rid.clone()))?;
    if model_admin_rate_limited(&state, authenticated.principal.device_id()) {
        return Err(GatewayError::RateLimited.with_request_id(rid));
    }
    let catalog = model_gate(&state, rid.clone())?;
    if request.provider.is_empty()
        || request.provider.len() > crate::protocol::MAX_DEVICE_ID_BYTES
        || request.provider.chars().any(char::is_control)
    {
        return Err(GatewayError::InvalidRequest.with_request_id(rid));
    }
    let response = catalog
        .discover(&request.provider)
        .map_err(|error| map_model_catalog_error(error, rid.clone()))?;
    if let Some(storage) = state.storage.as_ref() {
        let (at_ms, _) = clock_now();
        let _ = storage.record_model_admin_audit(
            &format!("audit-discover-{at_ms}-{}", authenticated.principal.device_id()),
            "discover",
            authenticated.principal.device_id(),
            Some(&request.provider),
            at_ms,
        );
    }
    Ok(Json(response))
}

async fn add_models(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteModelAddRequest>,
) -> Result<Json<RemoteModelAddResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    authenticated
        .principal
        .require(crate::principal::RemoteScope::ModelAdmin)
        .map_err(|_| GatewayError::Forbidden.with_request_id(rid.clone()))?;
    if model_admin_rate_limited(&state, authenticated.principal.device_id()) {
        return Err(GatewayError::RateLimited.with_request_id(rid));
    }
    let catalog = model_gate(&state, rid.clone())?;
    if request.provider.is_empty()
        || request.provider.len() > crate::protocol::MAX_DEVICE_ID_BYTES
        || request.provider.chars().any(char::is_control)
    {
        return Err(GatewayError::InvalidRequest.with_request_id(rid));
    }
    let allowlist = load_allowlist(&state)?;
    let response = catalog
        .add(&request.provider, &request.models, &allowlist)
        .map_err(|error| map_model_catalog_error(error, rid.clone()))?;
    if let Some(storage) = state.storage.as_ref() {
        let (at_ms, _) = clock_now();
        let _ = storage.record_model_admin_audit(
            &format!("audit-add-{at_ms}-{}", authenticated.principal.device_id()),
            "add",
            authenticated.principal.device_id(),
            Some(&request.provider),
            at_ms,
        );
    }
    Ok(Json(response))
}

async fn enable_remote_model(
    State(state): State<Arc<GatewayState>>,
    Path(model_ref): Path<String>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteModelEnableRequest>,
) -> Result<Json<RemoteModelEnableResponse>, GatewayErrorResponse> {
    let rid = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(rid.clone()))?;
    authenticated
        .principal
        .require(crate::principal::RemoteScope::ModelAdmin)
        .map_err(|_| GatewayError::Forbidden.with_request_id(rid.clone()))?;
    if model_admin_rate_limited(&state, authenticated.principal.device_id()) {
        return Err(GatewayError::RateLimited.with_request_id(rid));
    }
    let catalog = model_gate(&state, rid.clone())?;
    validate_model_ref(&model_ref)
        .map_err(|_| GatewayError::InvalidRequest.with_request_id(rid.clone()))?;
    let allowlist = load_allowlist(&state)?;
    let response = catalog
        .list(&allowlist)
        .map_err(|error| map_model_catalog_error(error, rid.clone()))?;
    if !response
        .models
        .iter()
        .any(|entry| entry.model_ref == model_ref)
    {
        return Err(GatewayError::NotFound.with_request_id(rid));
    }
    let storage = state
        .storage
        .as_ref()
        .ok_or_else(|| GatewayError::ServiceUnavailable.with_request_id(rid.clone()))?;
    let (_, duplicate) = storage
        .set_model_remote_allowed(&model_ref, request.enabled, clock_now().0)
        .map_err(|error| map_storage_error(error, rid.clone()))?;
    let (at_ms, _) = clock_now();
    let _ = storage.record_model_admin_audit(
        &format!("audit-enable-{at_ms}-{}", authenticated.principal.device_id()),
        "enable",
        authenticated.principal.device_id(),
        Some(&model_ref),
        at_ms,
    );
    Ok(Json(RemoteModelEnableResponse {
        model_ref,
        remote_allowed: request.enabled,
        duplicate,
    }))
}
