use super::auth::authenticate_headers;
use super::errors::{request_id, GatewayError, GatewayErrorResponse};
use crate::conversation_runtime::ConversationRuntimeManager;
use crate::device_store::DeviceRegistry;
use crate::event_hub::{EventHub, EventHubConfig, EventHubError, EventSubscription};
use crate::identity::CertificateIdentity;
use crate::observability::V2Metrics;
use crate::interaction::{InteractionError, InteractionManager};
use crate::models::HostModelCatalog;
use crate::pairing::PairingManager;
use crate::project_catalog::{ProjectCatalog, ProjectCatalogError};
use crate::protocol::{
    PairingRequest, RemoteInteractionResponse, RemoteProjectCapabilities, RemoteTaskCreateRequest,
};
use crate::storage::{IdempotencyRecord, RemoteStorage, StorageError, StoredTask};
use crate::task_manager::{TaskManager, TaskManagerError};
use crate::task_runtime::RemoteTaskResponse;
use crate::task_supervisor::TaskSupervisor;
use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequest, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;

pub const MAX_REST_BODY_BYTES: usize = 64 * 1024;
pub const REST_TIMEOUT: Duration = Duration::from_secs(10);
/// Half-open TCP connections (phone killed, wifi switched) never deliver a
/// close frame. An idle timeout tears the session down so the per-device
/// connection budget is released instead of leaking into 429s on reconnect.
pub const WS_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) struct BoundedJson<T>(pub(crate) T);

#[axum::async_trait]
impl<S, T> FromRequest<S> for BoundedJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = GatewayErrorResponse;

    async fn from_request(
        request: axum::extract::Request,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let request_id = request_id(request.headers());
        let body = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| {
                let error = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    GatewayError::PayloadTooLarge
                } else {
                    GatewayError::InvalidRequest
                };
                error.with_request_id(request_id.clone())
            })?;
        serde_json::from_slice(&body)
            .map(BoundedJson)
            .map_err(|_| GatewayError::InvalidRequest.with_request_id(request_id))
    }
}

#[derive(Clone)]
pub struct GatewayState {
    pub devices: Arc<DeviceRegistry>,
    pub pairing: Arc<PairingManager>,
    pub identity: Arc<CertificateIdentity>,
    pub server_version: Arc<str>,
    pub projects: Arc<ProjectCatalog>,
    pub event_hub: Arc<EventHub>,
    pub tasks: Arc<TaskManager>,
    pub interactions: Arc<InteractionManager>,
    pub supervisor: Arc<TaskSupervisor>,
    pub storage: Option<Arc<RemoteStorage>>,
    pub conversations: Option<Arc<ConversationRuntimeManager>>,
    pub models: Option<Arc<HostModelCatalog>>,
    /// Per-device sliding-window counters for elevated model-admin routes.
    pub model_admin_rate: Arc<Mutex<std::collections::HashMap<String, (u64, u32)>>>,
    pub metrics: Arc<V2Metrics>,
}

impl GatewayState {
    pub fn new(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
    ) -> Self {
        Self::with_runtime_config(
            identity,
            devices,
            server_version,
            crate::task_runtime::RemoteTaskRuntimeConfig::default(),
        )
    }

    pub fn with_runtime_config(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
        runtime_config: crate::task_runtime::RemoteTaskRuntimeConfig,
    ) -> Self {
        Self::build(
            identity,
            devices,
            server_version,
            runtime_config,
            None,
            Vec::new(),
        )
    }

    pub fn with_storage(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
        path: impl Into<std::path::PathBuf>,
    ) -> Result<Self, StorageError> {
        Self::with_runtime_config_and_storage(
            identity,
            devices,
            server_version,
            crate::task_runtime::RemoteTaskRuntimeConfig::default(),
            path,
        )
    }

    pub fn with_runtime_config_and_storage(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
        runtime_config: crate::task_runtime::RemoteTaskRuntimeConfig,
        path: impl Into<std::path::PathBuf>,
    ) -> Result<Self, StorageError> {
        let storage = Arc::new(RemoteStorage::open(path)?);
        let recovery_ms = now_ms();
        storage.recover_non_terminal_tasks(recovery_ms, &format_timestamp(recovery_ms))?;
        let recovered_conversations = storage
            .recover_non_terminal_turns(recovery_ms, &format_timestamp(recovery_ms))?;
        let cursors = storage.event_cursors()?;
        let stored_tasks = storage.load_tasks()?;
        let stored_idempotency = storage.load_idempotency(recovery_ms)?;
        let persisted_epoch = storage.identity_epoch()?;
        if persisted_epoch == 0 {
            storage.set_identity_epoch(
                devices
                    .identity_epoch()
                    .map_err(|_| StorageError::Corrupt)?,
            )?;
        } else {
            devices
                .restore_identity_epoch(persisted_epoch)
                .map_err(|_| StorageError::Corrupt)?;
        }
        for device in storage.list_devices()? {
            devices
                .restore_device(device)
                .map_err(|_| StorageError::Corrupt)?;
        }
        devices
            .restore_model_admin(storage.list_model_admin_grants()?)
            .map_err(|_| StorageError::Corrupt)?;
        let state = Self::build_with_restore(
            identity,
            devices,
            server_version,
            runtime_config,
            Some(storage),
            cursors,
            stored_tasks,
            stored_idempotency,
        )?;
        state
            .metrics
            .inc_host_interrupted_turns(recovered_conversations.len() as u64);
        Ok(state)
    }

    fn build(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
        runtime_config: crate::task_runtime::RemoteTaskRuntimeConfig,
        storage: Option<Arc<RemoteStorage>>,
        cursors: Vec<(String, u64)>,
    ) -> Self {
        Self::build_with_restore(
            identity,
            devices,
            server_version,
            runtime_config,
            storage,
            cursors,
            Vec::new(),
            Vec::new(),
        )
        .expect("empty remote-control restore must be valid")
    }

    fn build_with_restore(
        identity: CertificateIdentity,
        devices: Arc<DeviceRegistry>,
        server_version: impl Into<Arc<str>>,
        runtime_config: crate::task_runtime::RemoteTaskRuntimeConfig,
        storage: Option<Arc<RemoteStorage>>,
        cursors: Vec<(String, u64)>,
        stored_tasks: Vec<StoredTask>,
        stored_idempotency: Vec<IdempotencyRecord>,
    ) -> Result<Self, StorageError> {
        let event_hub = EventHub::new(EventHubConfig::default())
            .expect("static default event hub configuration must be valid");
        let pairing = Arc::new(PairingManager::new(Arc::clone(&devices)));
        for (device_id, sequence) in cursors {
            event_hub.seed_sequence(&device_id, sequence);
        }
        let projects = Arc::new(ProjectCatalog::new(Default::default()));
        let tasks = Arc::new(TaskManager::new(Arc::clone(&event_hub)));
        for task in stored_tasks {
            tasks
                .restore_task(task.snapshot, task.request)
                .map_err(|_| StorageError::Corrupt)?;
        }
        for record in stored_idempotency {
            tasks
                .restore_idempotency(
                    record.device_id,
                    record.request_id,
                    record.task_id,
                    record.fingerprint,
                    record.expires_at_ms,
                )
                .map_err(|_| StorageError::Corrupt)?;
        }
        let interactions = Arc::new(InteractionManager::new(Arc::clone(&event_hub)));
        let supervisor = TaskSupervisor::new(
            Arc::clone(&tasks),
            Arc::clone(&projects),
            Arc::clone(&interactions),
            Arc::clone(&event_hub),
            storage.clone(),
            runtime_config,
        );
        supervisor.start();
        Ok(Self {
            devices,
            pairing,
            identity: Arc::new(identity),
            server_version: server_version.into(),
            projects,
            tasks,
            interactions,
            supervisor,
            storage,
            event_hub,
            conversations: None,
            models: None,
            model_admin_rate: Arc::new(Mutex::new(std::collections::HashMap::new())),
            metrics: Arc::new(V2Metrics::default()),
        })
    }

    /// Wires the redacted host model catalog. `None` keeps model routes
    /// fail-closed (503) and conversation `modelRef` selection unavailable.
    pub fn with_models(mut self, catalog: Option<Arc<HostModelCatalog>>) -> Self {
        self.models = catalog;
        self
    }

    /// Wires the conversation runtime. V2 routes stay fail-closed (503)
    /// until both storage (schema v3) and the runtime (probe-proven
    /// adapter) are present.
    pub fn with_conversation_runtime(mut self, manager: Arc<ConversationRuntimeManager>) -> Self {
        self.metrics = manager.metrics();
        self.conversations = Some(manager);
        self
    }
}

pub fn build_router(state: GatewayState) -> Router {
    Router::new()
        .route("/pair", post(pair))
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/me", get(me))
        .route("/api/v1/server", get(server))
        .route("/api/v1/projects", get(projects))
        .route("/api/v1/projects/:project_id/tree", get(project_tree))
        .route("/api/v1/projects/:project_id/file", get(project_file))
        .route("/api/v1/tasks", get(tasks).post(create_task))
        .route("/api/v1/tasks/:task_id", get(task_snapshot))
        .route("/api/v1/tasks/:task_id/cancel", post(cancel_task))
        .route("/api/v1/interactions", get(interactions))
        .route(
            "/api/v1/interactions/:interaction_id",
            get(interaction_snapshot),
        )
        .route(
            "/api/v1/interactions/:interaction_id/response",
            post(respond_interaction),
        )
        .route("/api/v1/events", get(events))
        .merge(super::conversation_routes::v2_router())
        .layer(RequestBodyLimitLayer::new(MAX_REST_BODY_BYTES))
        .layer(TimeoutLayer::new(REST_TIMEOUT))
        .with_state(Arc::new(state))
}

async fn pair(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<PairingRequest>,
) -> Result<impl IntoResponse, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let response = state
        .pairing
        .redeem_response(request, now_ms())
        .map_err(|error| match error.error {
            crate::protocol::PairingFailureCode::InvalidTicket => {
                GatewayError::Unauthorized.with_request_id(request_id.clone())
            }
            crate::protocol::PairingFailureCode::RateLimited => {
                GatewayError::RateLimited.with_request_id(request_id.clone())
            }
            crate::protocol::PairingFailureCode::IdentityUnavailable => {
                GatewayError::ServiceUnavailable.with_request_id(request_id.clone())
            }
        })?;
    if let Some(storage) = &state.storage {
        let stored = state
            .devices
            .stored_device(&response.device_id)
            .map_err(|_| GatewayError::ServiceUnavailable.with_request_id(request_id.clone()))?;
        if storage.upsert_device(&stored).is_err() {
            let _ = state.devices.revoke(&response.device_id);
            return Err(GatewayError::ServiceUnavailable.with_request_id(request_id));
        }
    }
    Ok(Json(response))
}

#[derive(Debug, Serialize)]
struct CapabilitiesResponse {
    #[serde(rename = "protocolVersion")]
    protocol_version: u8,
    #[serde(rename = "maxRequestBodyBytes")]
    max_request_body_bytes: usize,
    #[serde(rename = "maxQueueSize")]
    max_queue_size: usize,
    #[serde(rename = "maxActiveTasks")]
    max_active_tasks: usize,
    #[serde(rename = "supportedInteractions")]
    supported_interactions: [&'static str; 3],
    project: RemoteProjectCapabilities,
}

async fn capabilities(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<CapabilitiesResponse>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    Ok(Json(CapabilitiesResponse {
        protocol_version: 1,
        max_request_body_bytes: MAX_REST_BODY_BYTES,
        max_queue_size: crate::task_manager::TASK_QUEUE_CAPACITY,
        max_active_tasks: 1,
        supported_interactions: ["confirm", "select", "input"],
        project: RemoteProjectCapabilities {
            max_tree_entries_per_page: crate::project_catalog::MAX_TREE_ENTRIES_PER_PAGE as u16,
            max_context_files: crate::protocol::MAX_CONTEXT_FILES as u8,
            max_relative_path_bytes: crate::protocol::MAX_RELATIVE_PATH_BYTES as u16,
            file_body_available: true,
        },
    }))
}

#[derive(Debug, Deserialize)]
struct TreeQuery {
    #[serde(default)]
    dir: String,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FileQuery {
    path: String,
}

async fn projects(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::protocol::RemoteProjectSummary>>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id))?;
    Ok(Json(state.projects.list_projects()))
}

async fn project_tree(
    State(state): State<Arc<GatewayState>>,
    Path(project_id): Path<String>,
    Query(query): Query<TreeQuery>,
    headers: HeaderMap,
) -> Result<Json<crate::protocol::RemoteTreePage>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let page = state
        .projects
        .tree(&project_id, &query.dir, query.cursor.as_deref())
        .map_err(|error| map_project_error(error, request_id.clone()))?;
    Ok(Json(page))
}

async fn project_file(
    State(state): State<Arc<GatewayState>>,
    Path(project_id): Path<String>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Json<crate::protocol::RemoteFileBody>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let body = state
        .projects
        .read_file_body(&project_id, &query.path)
        .map_err(|error| map_project_error(error, request_id.clone()))?;
    Ok(Json(body))
}

async fn create_task(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
    BoundedJson(request): BoundedJson<RemoteTaskCreateRequest>,
) -> Result<Json<crate::protocol::RemoteTaskSnapshot>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    state
        .projects
        .project_summary(&request.project_id)
        .map_err(|error| map_project_error(error, request_id.clone()))?;
    for file in &request.context_files {
        state
            .projects
            .resolve_context_file(&request.project_id, &file.relative_path)
            .map_err(|error| map_project_error(error, request_id.clone()))?;
    }
    let outcome = state
        .tasks
        .submit(&authenticated.principal, request)
        .map_err(|error| map_task_error(error, request_id.clone()))?;
    if !outcome.duplicate {
        state.supervisor.persist_task(
            authenticated.principal.device_id(),
            &outcome.snapshot.task_id,
        );
    }
    Ok(Json(outcome.snapshot))
}

async fn tasks(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::protocol::RemoteTaskSnapshot>>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let snapshots = state
        .tasks
        .list_owned(&authenticated.principal)
        .map_err(|error| map_task_error(error, request_id))?;
    Ok(Json(snapshots))
}

async fn task_snapshot(
    State(state): State<Arc<GatewayState>>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<crate::protocol::RemoteTaskSnapshot>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let snapshot = state
        .tasks
        .snapshot(&authenticated.principal, &task_id)
        .map_err(|error| map_task_error(error, request_id))?;
    Ok(Json(snapshot))
}

async fn cancel_task(
    State(state): State<Arc<GatewayState>>,
    Path(task_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<crate::protocol::RemoteTaskSnapshot>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let outcome = state
        .tasks
        .cancel(&authenticated.principal, &task_id)
        .map_err(|error| map_task_error(error, request_id))?;
    state.supervisor.cancel(&task_id);
    state
        .supervisor
        .persist_task(authenticated.principal.device_id(), &task_id);
    Ok(Json(outcome.snapshot))
}

async fn interactions(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::protocol::RemoteInteractionSnapshot>>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let snapshots = state
        .interactions
        .list_owned(&authenticated.principal)
        .map_err(|error| map_interaction_error(error, request_id))?;
    Ok(Json(snapshots))
}

async fn interaction_snapshot(
    State(state): State<Arc<GatewayState>>,
    Path(interaction_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<crate::protocol::RemoteInteractionSnapshot>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let snapshot = state
        .interactions
        .snapshot(&authenticated.principal, &interaction_id)
        .map_err(|error| map_interaction_error(error, request_id))?;
    Ok(Json(snapshot))
}

async fn respond_interaction(
    State(state): State<Arc<GatewayState>>,
    Path(interaction_id): Path<String>,
    headers: HeaderMap,
    BoundedJson(response): BoundedJson<RemoteInteractionResponse>,
) -> Result<Json<crate::protocol::RemoteInteractionSnapshot>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    if response.interaction_id != interaction_id {
        return Err(GatewayError::InvalidRequest.with_request_id(request_id));
    }
    let runtime_response = RemoteTaskResponse {
        interaction_id: response.interaction_id.clone(),
        value: response.value.clone(),
    };
    let outcome = state
        .interactions
        .respond(&authenticated.principal, response)
        .map_err(|error| map_interaction_error(error, request_id))?;
    let _ = state.supervisor.respond(runtime_response);
    Ok(Json(outcome.snapshot))
}

#[derive(Debug, Deserialize)]
struct EventsQuery {
    after: Option<u64>,
}

static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

async fn events(
    ws: WebSocketUpgrade,
    State(state): State<Arc<GatewayState>>,
    Query(query): Query<EventsQuery>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id.clone()))?;
    let connection_id = format!("ws-{}", NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed));
    state
        .devices
        .open_connection(&authenticated.principal, &connection_id)
        .map_err(|error| map_connection_error(error, request_id.clone()))?;
    let subscription = match state.event_hub.subscribe_owned(
        &authenticated.principal,
        crate::event_hub::MAX_SUBSCRIBER_QUEUE,
    ) {
        Ok(subscription) => subscription,
        Err(error) => {
            state
                .devices
                .close_connection(authenticated.principal.device_id(), &connection_id);
            return Err(map_event_hub_error(error, request_id));
        }
    };
    let principal = authenticated.principal;
    let device_id = principal.device_id().to_owned();
    let subscription_id = subscription.id;
    let failure_state = Arc::clone(&state);
    let failure_device_id = device_id.clone();
    let failure_connection_id = connection_id.clone();
    let replay_storage = state.storage.clone();
    Ok(ws
        .on_failed_upgrade(move |_| {
            failure_state.event_hub.unsubscribe(subscription_id);
            failure_state
                .devices
                .close_connection(&failure_device_id, &failure_connection_id);
        })
        .on_upgrade(move |socket| {
            websocket_session(
                socket,
                state,
                principal,
                device_id,
                connection_id,
                subscription,
                query.after,
                replay_storage,
            )
        }))
}

async fn websocket_session(
    mut socket: WebSocket,
    state: Arc<GatewayState>,
    principal: crate::principal::Principal,
    device_id: String,
    connection_id: String,
    subscription: EventSubscription,
    after: Option<u64>,
    storage: Option<Arc<RemoteStorage>>,
) {
    let replay = if let Some(storage) = storage.as_ref() {
        match storage.load_events(&device_id, after) {
            Ok(events) => events
                .into_iter()
                .map(|event| event.payload)
                .collect::<Vec<_>>(),
            Err(_) => {
                state.event_hub.unsubscribe(subscription.id);
                state.devices.close_connection(&device_id, &connection_id);
                return;
            }
        }
    } else {
        state
            .event_hub
            .replay_owned(&principal, after, &now_timestamp())
            .ok()
            .map(|result| result.events)
            .unwrap_or_default()
    };
    let mut last_replayed_sequence = replay.last().map(event_sequence).unwrap_or(0);
    for event in replay {
        if send_event(&mut socket, &event).await.is_err() {
            state.event_hub.unsubscribe(subscription.id);
            state.devices.close_connection(&device_id, &connection_id);
            return;
        }
    }
    let mut last_activity = std::time::Instant::now();

    loop {
        loop {
            match subscription.try_recv() {
                Ok(event) => {
                    if event_sequence(&event) <= last_replayed_sequence {
                        continue;
                    }
                    last_replayed_sequence = event_sequence(&event);
                    if send_event(&mut socket, &event).await.is_err() {
                        state.event_hub.unsubscribe(subscription.id);
                        state.devices.close_connection(&device_id, &connection_id);
                        return;
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    state.devices.close_connection(&device_id, &connection_id);
                    return;
                }
            }
        }
        match tokio::time::timeout(std::time::Duration::from_millis(100), socket.recv()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) => break,
            Ok(Some(Ok(Message::Ping(payload)))) => {
                last_activity = std::time::Instant::now();
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Ok(Some(Ok(Message::Pong(_)))) => last_activity = std::time::Instant::now(),
            Ok(Some(Ok(Message::Text(_)))) | Ok(Some(Ok(Message::Binary(_)))) => {
                last_activity = std::time::Instant::now();
            }
            Err(_) => {
                // No frame within the poll window. A half-open connection
                // never signals EOF; the idle deadline is the only way to
                // reclaim its connection budget.
                if last_activity.elapsed() >= WS_IDLE_TIMEOUT {
                    break;
                }
            }
        }
    }
    state.event_hub.unsubscribe(subscription.id);
    state.devices.close_connection(&device_id, &connection_id);
}

async fn send_event(
    socket: &mut WebSocket,
    event: &crate::protocol::RemoteEvent,
) -> Result<(), ()> {
    let payload = serde_json::to_string(event).map_err(|_| ())?;
    socket.send(Message::Text(payload)).await.map_err(|_| ())
}

fn now_timestamp() -> String {
    format_timestamp(now_ms())
}

fn event_sequence(event: &crate::protocol::RemoteEvent) -> u64 {
    match event {
        crate::protocol::RemoteEvent::TaskCreated { base, .. }
        | crate::protocol::RemoteEvent::TaskStateChanged { base, .. }
        | crate::protocol::RemoteEvent::TaskOutputAppended { base, .. }
        | crate::protocol::RemoteEvent::TaskCompleted { base, .. }
        | crate::protocol::RemoteEvent::TaskChanges { base, .. }
        | crate::protocol::RemoteEvent::InteractionRequested { base, .. }
        | crate::protocol::RemoteEvent::InteractionResolved { base, .. }
        | crate::protocol::RemoteEvent::InteractionExpired { base, .. }
        | crate::protocol::RemoteEvent::SnapshotRequired { base, .. }
        | crate::protocol::RemoteEvent::EventBackpressure { base, .. } => base.sequence,
    }
}

fn format_timestamp(unix_ms: u64) -> String {
    let seconds = unix_ms / 1000;
    let millis = unix_ms % 1000;
    let days = seconds / 86_400;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}

fn map_project_error(
    error: ProjectCatalogError,
    request_id: Option<String>,
) -> GatewayErrorResponse {
    let gateway_error = match error {
        ProjectCatalogError::ProjectNotFound
        | ProjectCatalogError::InvalidProjectId
        | ProjectCatalogError::InvalidCursor => GatewayError::NotFound,
        ProjectCatalogError::InvalidRelativePath
        | ProjectCatalogError::PathPolicy
        | ProjectCatalogError::DeniedEntry
        | ProjectCatalogError::ReparsePoint
        | ProjectCatalogError::NotDirectory
        | ProjectCatalogError::NotRegularFile
        | ProjectCatalogError::FileNotText
        | ProjectCatalogError::NameInvalid => GatewayError::InvalidRequest,
        ProjectCatalogError::CursorStoreFull | ProjectCatalogError::ProjectLimit => {
            GatewayError::RateLimited
        }
        ProjectCatalogError::ProjectIdCollision
        | ProjectCatalogError::IdentityUnavailable
        | ProjectCatalogError::Io => GatewayError::ServiceUnavailable,
    };
    gateway_error.with_request_id(request_id)
}

fn map_task_error(error: TaskManagerError, request_id: Option<String>) -> GatewayErrorResponse {
    let gateway_error = match error {
        TaskManagerError::Unauthorized => GatewayError::Unauthorized,
        TaskManagerError::TaskNotFound => GatewayError::NotFound,
        TaskManagerError::InvalidRequest(_) => GatewayError::InvalidRequest,
        TaskManagerError::QueueFull
        | TaskManagerError::CapacityExceeded
        | TaskManagerError::IdempotencyStoreFull => GatewayError::RateLimited,
        TaskManagerError::IdempotencyConflict => GatewayError::Conflict,
        TaskManagerError::ActiveTaskExists
        | TaskManagerError::InvalidTransition { .. }
        | TaskManagerError::AlreadyTerminal => GatewayError::Conflict,
        TaskManagerError::RestoreConflict => GatewayError::ServiceUnavailable,
    };
    gateway_error.with_request_id(request_id)
}

fn map_interaction_error(
    error: InteractionError,
    request_id: Option<String>,
) -> GatewayErrorResponse {
    let gateway_error = match error {
        InteractionError::Unauthorized => GatewayError::Unauthorized,
        InteractionError::NotFound => GatewayError::NotFound,
        InteractionError::InvalidRequest(_) | InteractionError::InvalidResponse(_) => {
            GatewayError::InvalidRequest
        }
        InteractionError::Expired | InteractionError::AlreadyResolved => GatewayError::Conflict,
    };
    gateway_error.with_request_id(request_id)
}

pub(crate) fn map_connection_error(
    error: crate::device_store::DeviceStoreError,
    request_id: Option<String>,
) -> GatewayErrorResponse {
    let gateway_error = match error {
        crate::device_store::DeviceStoreError::ConnectionLimit => GatewayError::RateLimited,
        crate::device_store::DeviceStoreError::IdentityEpochMismatch
        | crate::device_store::DeviceStoreError::AuthenticationFailed => GatewayError::Unauthorized,
        _ => GatewayError::ServiceUnavailable,
    };
    gateway_error.with_request_id(request_id)
}

fn map_event_hub_error(error: EventHubError, request_id: Option<String>) -> GatewayErrorResponse {
    let gateway_error = match error {
        EventHubError::SubscriberLimit => GatewayError::RateLimited,
        EventHubError::InvalidDeviceId | EventHubError::InvalidCapacity => {
            GatewayError::InvalidRequest
        }
    };
    gateway_error.with_request_id(request_id)
}

#[derive(Debug, Serialize)]
struct MeResponse {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(rename = "identityEpoch")]
    identity_epoch: u64,
    scopes: [&'static str; 6],
}

async fn me(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<MeResponse>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    let authenticated = authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id))?;
    Ok(Json(MeResponse {
        device_id: authenticated.principal.device_id().to_owned(),
        identity_epoch: authenticated.principal.identity_epoch(),
        scopes: [
            "read_capabilities",
            "read_projects",
            "create_tasks",
            "read_owned_tasks",
            "cancel_owned_tasks",
            "respond_to_owned_interactions",
        ],
    }))
}

#[derive(Debug, Serialize)]
struct ServerResponse {
    status: &'static str,
    #[serde(rename = "protocolVersion")]
    protocol_version: u8,
    #[serde(rename = "serverVersion")]
    server_version: String,
    #[serde(rename = "identityEpoch")]
    identity_epoch: u64,
    #[serde(rename = "certificatePin")]
    certificate_pin: crate::protocol::CertificatePin,
}

async fn server(
    State(state): State<Arc<GatewayState>>,
    headers: HeaderMap,
) -> Result<Json<ServerResponse>, GatewayErrorResponse> {
    let request_id = request_id(&headers);
    authenticate_headers(&state.devices, &headers)
        .map_err(|error| error.with_request_id(request_id))?;
    let identity_epoch = state
        .devices
        .identity_epoch()
        .map_err(|_| GatewayError::ServiceUnavailable.with_request_id(None))?;
    Ok(Json(ServerResponse {
        status: "ready",
        protocol_version: 1,
        server_version: state.server_version.to_string(),
        identity_epoch,
        certificate_pin: state.identity.certificate_pin().clone(),
    }))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
