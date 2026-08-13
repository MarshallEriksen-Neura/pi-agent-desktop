use crate::event_hub::{EventHub, EventPayload};
use crate::principal::{AuthorizationError, Principal, RemoteScope};
use crate::protocol::{
    can_transition_remote_task, RemoteTaskCreateRequest, RemoteTaskError, RemoteTaskFailureCode,
    RemoteTaskSnapshot, RemoteTaskState, RemoteTaskTerminalState, ValidationError,
    MAX_CONTEXT_FILES,
};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const TASK_QUEUE_CAPACITY: usize = 8;
pub const IDEMPOTENCY_TTL: Duration = Duration::from_secs(24 * 60 * 60);
pub const MAX_STORED_TASKS: usize = 500;
pub const MAX_IDEMPOTENCY_ENTRIES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClockReading {
    pub unix_ms: u64,
    pub timestamp: String,
}

pub trait Clock: Send + Sync {
    fn now(&self) -> ClockReading;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> ClockReading {
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        ClockReading {
            unix_ms,
            timestamp: format_timestamp(unix_ms),
        }
    }
}

#[derive(Debug)]
pub struct ManualClock {
    unix_ms: AtomicU64,
}

impl ManualClock {
    pub fn new(unix_ms: u64) -> Arc<Self> {
        Arc::new(Self {
            unix_ms: AtomicU64::new(unix_ms),
        })
    }

    pub fn set(&self, unix_ms: u64) {
        self.unix_ms.store(unix_ms, Ordering::Relaxed);
    }

    pub fn advance(&self, duration: Duration) {
        self.unix_ms
            .fetch_add(duration.as_millis() as u64, Ordering::Relaxed);
    }
}

impl Clock for ManualClock {
    fn now(&self) -> ClockReading {
        let unix_ms = self.unix_ms.load(Ordering::Relaxed);
        ClockReading {
            unix_ms,
            timestamp: format_timestamp(unix_ms),
        }
    }
}

#[derive(Debug, Clone)]
pub struct TaskManagerConfig {
    pub queue_capacity: usize,
    pub max_stored_tasks: usize,
    pub max_idempotency_entries: usize,
}

impl Default for TaskManagerConfig {
    fn default() -> Self {
        Self {
            queue_capacity: TASK_QUEUE_CAPACITY,
            max_stored_tasks: MAX_STORED_TASKS,
            max_idempotency_entries: MAX_IDEMPOTENCY_ENTRIES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskManagerError {
    Unauthorized,
    InvalidRequest(ValidationError),
    QueueFull,
    CapacityExceeded,
    IdempotencyConflict,
    TaskNotFound,
    ActiveTaskExists,
    InvalidTransition {
        from: RemoteTaskState,
        to: RemoteTaskState,
    },
    AlreadyTerminal,
    IdempotencyStoreFull,
    RestoreConflict,
}

impl fmt::Display for TaskManagerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized | Self::TaskNotFound => write!(f, "task is not available"),
            Self::InvalidRequest(error) => error.fmt(f),
            Self::QueueFull => write!(f, "task queue is full"),
            Self::CapacityExceeded | Self::IdempotencyStoreFull => {
                write!(f, "task capacity is temporarily unavailable")
            }
            Self::IdempotencyConflict => write!(f, "request id was already used"),
            Self::ActiveTaskExists => write!(f, "another task is active"),
            Self::InvalidTransition { .. } | Self::AlreadyTerminal => {
                write!(f, "task transition is not allowed")
            }
            Self::RestoreConflict => write!(f, "persisted task state is inconsistent"),
        }
    }
}

impl std::error::Error for TaskManagerError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitOutcome {
    pub snapshot: RemoteTaskSnapshot,
    pub duplicate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelOutcome {
    pub snapshot: RemoteTaskSnapshot,
    pub duplicate: bool,
}

#[derive(Debug, Clone)]
struct IdempotencyEntry {
    task_id: String,
    expires_at_ms: u64,
    fingerprint: u64,
}

#[derive(Debug, Clone)]
struct TaskRecord {
    snapshot: RemoteTaskSnapshot,
    request: RemoteTaskCreateRequest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedTask {
    pub snapshot: RemoteTaskSnapshot,
    pub request: RemoteTaskCreateRequest,
}

struct TaskManagerInner {
    next_task_id: u64,
    tasks: HashMap<String, TaskRecord>,
    queue: VecDeque<String>,
    active_task_id: Option<String>,
    idempotency: HashMap<(String, String), IdempotencyEntry>,
}

pub struct TaskManager {
    config: TaskManagerConfig,
    clock: Arc<dyn Clock>,
    event_hub: Arc<EventHub>,
    namespace: u64,
    inner: Mutex<TaskManagerInner>,
}

impl TaskManager {
    pub fn new(event_hub: Arc<EventHub>) -> Self {
        Self::with_clock_and_config(
            event_hub,
            Arc::new(SystemClock),
            TaskManagerConfig::default(),
        )
    }

    pub fn with_clock(event_hub: Arc<EventHub>, clock: Arc<dyn Clock>) -> Self {
        Self::with_clock_and_config(event_hub, clock, TaskManagerConfig::default())
    }

    pub fn with_clock_and_config(
        event_hub: Arc<EventHub>,
        clock: Arc<dyn Clock>,
        config: TaskManagerConfig,
    ) -> Self {
        // Invalid host configuration fails closed to the documented bounded
        // defaults instead of panicking during desktop startup.
        let config = if config.queue_capacity == 0
            || config.queue_capacity > TASK_QUEUE_CAPACITY
            || config.max_stored_tasks == 0
            || config.max_stored_tasks > MAX_STORED_TASKS
            || config.max_idempotency_entries == 0
            || config.max_idempotency_entries > MAX_IDEMPOTENCY_ENTRIES
        {
            TaskManagerConfig::default()
        } else {
            config
        };
        static NEXT_NAMESPACE: AtomicU64 = AtomicU64::new(1);
        Self {
            config,
            clock,
            event_hub,
            namespace: NEXT_NAMESPACE.fetch_add(1, Ordering::Relaxed),
            inner: Mutex::new(TaskManagerInner {
                next_task_id: 1,
                tasks: HashMap::new(),
                queue: VecDeque::new(),
                active_task_id: None,
                idempotency: HashMap::new(),
            }),
        }
    }

    /// Hydrates a task snapshot before the supervisor starts. Persisted
    /// non-terminal work should already have been converted to a terminal
    /// restart failure by RemoteStorage; a queued task without its original
    /// request is rejected rather than being launched with incomplete input.
    pub fn restore_task(
        &self,
        snapshot: RemoteTaskSnapshot,
        request: Option<RemoteTaskCreateRequest>,
    ) -> Result<(), TaskManagerError> {
        let request = match request {
            Some(request) => {
                request
                    .validate()
                    .map_err(TaskManagerError::InvalidRequest)?;
                if request.request_id != snapshot.request_id
                    || request.project_id != snapshot.project_id
                    || request.context_files != snapshot.context_files
                    || request.request_id.is_empty()
                {
                    return Err(TaskManagerError::RestoreConflict);
                }
                request
            }
            None if snapshot.state.is_terminal() => RemoteTaskCreateRequest {
                request_id: snapshot.request_id.clone(),
                project_id: snapshot.project_id.clone(),
                prompt: "[restored terminal task]".to_owned(),
                context_files: snapshot.context_files.clone(),
                execution_profile: None,
            },
            None => return Err(TaskManagerError::RestoreConflict),
        };
        let mut inner = self.lock_inner();
        if inner.tasks.contains_key(&snapshot.task_id)
            || inner.tasks.len() >= self.config.max_stored_tasks
        {
            return Err(TaskManagerError::RestoreConflict);
        }
        if snapshot.state == RemoteTaskState::Queued {
            if inner.queue.len() >= self.config.queue_capacity {
                return Err(TaskManagerError::RestoreConflict);
            }
            inner.queue.push_back(snapshot.task_id.clone());
        } else if !snapshot.state.is_terminal() {
            return Err(TaskManagerError::RestoreConflict);
        }
        inner
            .tasks
            .insert(snapshot.task_id.clone(), TaskRecord { snapshot, request });
        Ok(())
    }

    pub fn restore_idempotency(
        &self,
        device_id: String,
        request_id: String,
        task_id: String,
        fingerprint: u64,
        expires_at_ms: u64,
    ) -> Result<(), TaskManagerError> {
        if expires_at_ms <= self.clock.now().unix_ms {
            return Ok(());
        }
        let mut inner = self.lock_inner();
        let task = inner
            .tasks
            .get(&task_id)
            .ok_or(TaskManagerError::RestoreConflict)?;
        if task.snapshot.owner_device_id != device_id || task.snapshot.request_id != request_id {
            return Err(TaskManagerError::RestoreConflict);
        }
        let key = (device_id, request_id);
        if let Some(existing) = inner.idempotency.get(&key) {
            if existing.task_id != task_id
                || existing.fingerprint != fingerprint
                || existing.expires_at_ms != expires_at_ms
            {
                return Err(TaskManagerError::RestoreConflict);
            }
            return Ok(());
        }
        if inner.idempotency.len() >= self.config.max_idempotency_entries {
            return Err(TaskManagerError::RestoreConflict);
        }
        inner.idempotency.insert(
            key,
            IdempotencyEntry {
                task_id,
                fingerprint,
                expires_at_ms,
            },
        );
        Ok(())
    }

    pub fn submit(
        &self,
        principal: &Principal,
        request: RemoteTaskCreateRequest,
    ) -> Result<SubmitOutcome, TaskManagerError> {
        principal
            .require(RemoteScope::CreateTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        request
            .validate()
            .map_err(TaskManagerError::InvalidRequest)?;
        if request.context_files.len() > MAX_CONTEXT_FILES {
            return Err(TaskManagerError::InvalidRequest(ValidationError::TooMany {
                field: "contextFiles",
                max: MAX_CONTEXT_FILES,
            }));
        }
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        inner
            .idempotency
            .retain(|_, entry| entry.expires_at_ms > now.unix_ms);
        if let Some(entry) = inner
            .idempotency
            .get(&(principal.device_id().to_owned(), request.request_id.clone()))
        {
            if entry.fingerprint != request_fingerprint(&request) {
                return Err(TaskManagerError::IdempotencyConflict);
            }
            if let Some(record) = inner.tasks.get(&entry.task_id) {
                return Ok(SubmitOutcome {
                    snapshot: record.snapshot.clone(),
                    duplicate: true,
                });
            }
        }
        if inner.queue.len() >= self.config.queue_capacity {
            return Err(TaskManagerError::QueueFull);
        }
        if inner.tasks.len() >= self.config.max_stored_tasks {
            return Err(TaskManagerError::CapacityExceeded);
        }
        if inner.idempotency.len() >= self.config.max_idempotency_entries {
            return Err(TaskManagerError::IdempotencyStoreFull);
        }

        let task_id = format!("task-{}-{}", self.namespace, inner.next_task_id);
        inner.next_task_id += 1;
        let fingerprint = request_fingerprint(&request);
        let request_id = request.request_id.clone();
        let snapshot = RemoteTaskSnapshot {
            task_id: task_id.clone(),
            request_id: request_id.clone(),
            owner_device_id: principal.device_id().to_owned(),
            project_id: request.project_id.clone(),
            state: RemoteTaskState::Queued,
            created_at: now.timestamp.clone(),
            updated_at: now.timestamp.clone(),
            started_at: None,
            finished_at: None,
            context_files: request.context_files.clone(),
            error: None,
        };
        inner.tasks.insert(
            task_id.clone(),
            TaskRecord {
                snapshot: snapshot.clone(),
                request,
            },
        );
        inner.queue.push_back(task_id);
        inner.idempotency.insert(
            (principal.device_id().to_owned(), request_id),
            IdempotencyEntry {
                task_id: snapshot.task_id.clone(),
                expires_at_ms: now
                    .unix_ms
                    .saturating_add(IDEMPOTENCY_TTL.as_millis() as u64),
                fingerprint,
            },
        );
        drop(inner);
        self.event_hub.publish(
            principal.device_id(),
            now.timestamp,
            EventPayload::TaskCreated(snapshot.clone()),
        );
        Ok(SubmitOutcome {
            snapshot,
            duplicate: false,
        })
    }

    pub fn snapshot(
        &self,
        principal: &Principal,
        task_id: &str,
    ) -> Result<RemoteTaskSnapshot, TaskManagerError> {
        principal
            .require(RemoteScope::ReadOwnedTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        let inner = self.lock_inner();
        let record = inner
            .tasks
            .get(task_id)
            .ok_or(TaskManagerError::TaskNotFound)?;
        if !principal.owns(&record.snapshot.owner_device_id) {
            return Err(TaskManagerError::TaskNotFound);
        }
        Ok(record.snapshot.clone())
    }

    pub fn list_owned(
        &self,
        principal: &Principal,
    ) -> Result<Vec<RemoteTaskSnapshot>, TaskManagerError> {
        principal
            .require(RemoteScope::ReadOwnedTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        let inner = self.lock_inner();
        let mut snapshots = inner
            .tasks
            .values()
            .filter(|record| principal.owns(&record.snapshot.owner_device_id))
            .map(|record| record.snapshot.clone())
            .collect::<Vec<_>>();
        snapshots.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.task_id.cmp(&left.task_id))
        });
        Ok(snapshots)
    }

    pub fn start(
        &self,
        principal: &Principal,
        task_id: &str,
    ) -> Result<RemoteTaskSnapshot, TaskManagerError> {
        principal
            .require_owner(principal.device_id(), RemoteScope::ReadOwnedTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        let mut inner = self.lock_inner();
        let current_state = inner
            .tasks
            .get(task_id)
            .ok_or(TaskManagerError::TaskNotFound)?
            .snapshot
            .clone();
        if !principal.owns(&current_state.owner_device_id) {
            return Err(TaskManagerError::TaskNotFound);
        }
        if inner.active_task_id.is_some() {
            return Err(TaskManagerError::ActiveTaskExists);
        }
        if !inner.queue.iter().any(|queued| queued == task_id) {
            return Err(TaskManagerError::InvalidTransition {
                from: current_state.state,
                to: RemoteTaskState::Starting,
            });
        }
        inner.queue.retain(|queued| queued != task_id);
        inner.active_task_id = Some(task_id.to_owned());
        drop(inner);
        self.transition_internal(task_id, RemoteTaskState::Starting, None)
    }

    /// Claims the oldest queued task for the trusted local runtime.  This is
    /// intentionally not exposed through an HTTP principal: the gateway
    /// supervisor is the only component allowed to acquire the single active
    /// runtime lease.
    pub fn claim_next(&self) -> Option<ClaimedTask> {
        let task_id = {
            let mut inner = self.lock_inner();
            if inner.active_task_id.is_some() {
                return None;
            }
            let task_id = inner.queue.pop_front()?;
            inner.active_task_id = Some(task_id.clone());
            task_id
        };
        let snapshot = match self.transition_internal(&task_id, RemoteTaskState::Starting, None) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                let mut inner = self.lock_inner();
                inner.active_task_id = None;
                inner.queue.retain(|queued| queued != &task_id);
                return None;
            }
        };
        let request = self
            .lock_inner()
            .tasks
            .get(&task_id)
            .map(|record| record.request.clone())?;
        Some(ClaimedTask { snapshot, request })
    }

    /// Returns a task request for the trusted runtime after re-reading the
    /// authoritative in-memory record.  No filesystem path is present in the
    /// request; the supervisor must resolve the opaque project id separately.
    pub fn request(&self, task_id: &str) -> Option<RemoteTaskCreateRequest> {
        self.lock_inner()
            .tasks
            .get(task_id)
            .map(|record| record.request.clone())
    }

    pub fn idempotency_record(&self, task_id: &str) -> Option<(String, String, u64, u64)> {
        self.lock_inner()
            .idempotency
            .iter()
            .find(|(_, entry)| entry.task_id == task_id)
            .map(|((device_id, request_id), entry)| {
                (
                    device_id.clone(),
                    request_id.clone(),
                    entry.fingerprint,
                    entry.expires_at_ms,
                )
            })
    }

    pub fn transition_owned(
        &self,
        principal: &Principal,
        task_id: &str,
        next_state: RemoteTaskState,
        error: Option<RemoteTaskError>,
    ) -> Result<RemoteTaskSnapshot, TaskManagerError> {
        principal
            .require(RemoteScope::ReadOwnedTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        {
            let inner = self.lock_inner();
            let record = inner
                .tasks
                .get(task_id)
                .ok_or(TaskManagerError::TaskNotFound)?;
            if !principal.owns(&record.snapshot.owner_device_id) {
                return Err(TaskManagerError::TaskNotFound);
            }
        }
        self.transition_internal(task_id, next_state, error)
    }

    pub fn cancel(
        &self,
        principal: &Principal,
        task_id: &str,
    ) -> Result<CancelOutcome, TaskManagerError> {
        principal
            .require(RemoteScope::CancelOwnedTasks)
            .map_err(|_| TaskManagerError::Unauthorized)?;
        let snapshot = {
            let inner = self.lock_inner();
            let record = inner
                .tasks
                .get(task_id)
                .ok_or(TaskManagerError::TaskNotFound)?;
            if !principal.owns(&record.snapshot.owner_device_id) {
                return Err(TaskManagerError::TaskNotFound);
            }
            record.snapshot.clone()
        };
        if snapshot.state.is_terminal() {
            return Ok(CancelOutcome {
                snapshot,
                duplicate: true,
            });
        }
        let error = RemoteTaskError {
            code: RemoteTaskFailureCode::Cancelled,
            message: "task cancelled".to_owned(),
            retryable: false,
        };
        let snapshot =
            self.transition_internal(task_id, RemoteTaskState::Cancelled, Some(error))?;
        Ok(CancelOutcome {
            snapshot,
            duplicate: false,
        })
    }

    pub fn active_task_id(&self) -> Option<String> {
        self.lock_inner().active_task_id.clone()
    }

    pub fn owner_device_id(&self, task_id: &str) -> Option<String> {
        self.lock_inner()
            .tasks
            .get(task_id)
            .map(|record| record.snapshot.owner_device_id.clone())
    }

    pub fn queued_len(&self) -> usize {
        self.lock_inner().queue.len()
    }

    /// Atomically selects all non-terminal tasks for a revoked project and
    /// commits each task's terminal snapshot/event through the same path used
    /// by cancellation and runtime failure. Queued work fails without ever
    /// becoming active; an active task is cancelled so a future runtime can
    /// perform process-tree cleanup before releasing its lease.
    pub fn revoke_project(&self, project_id: &str) -> Vec<RemoteTaskSnapshot> {
        let task_ids = {
            let inner = self.lock_inner();
            inner
                .tasks
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.project_id == project_id && !record.snapshot.state.is_terminal()
                })
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>()
        };
        let mut revoked = Vec::new();
        for task_id in task_ids {
            let state = {
                let inner = self.lock_inner();
                inner
                    .tasks
                    .get(&task_id)
                    .map(|record| record.snapshot.state.clone())
            };
            let Some(state) = state else {
                continue;
            };
            let (next_state, code) = if state == RemoteTaskState::Queued {
                (
                    RemoteTaskState::Failed,
                    RemoteTaskFailureCode::ProjectRevoked,
                )
            } else {
                (
                    RemoteTaskState::Cancelled,
                    RemoteTaskFailureCode::ProjectRevoked,
                )
            };
            let error = RemoteTaskError {
                code,
                message: "project is no longer available".to_owned(),
                retryable: false,
            };
            if let Ok(snapshot) = self.transition_internal(&task_id, next_state, Some(error)) {
                revoked.push(snapshot);
            }
        }
        revoked
    }

    pub fn revoke_owner(&self, owner_device_id: &str) -> Vec<RemoteTaskSnapshot> {
        let task_ids = {
            let inner = self.lock_inner();
            inner
                .tasks
                .iter()
                .filter(|(_, record)| {
                    record.snapshot.owner_device_id == owner_device_id
                        && !record.snapshot.state.is_terminal()
                })
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>()
        };
        let mut revoked = Vec::new();
        for task_id in task_ids {
            let state = self
                .lock_inner()
                .tasks
                .get(&task_id)
                .map(|record| record.snapshot.state.clone());
            let Some(state) = state else { continue };
            let next_state = if state == RemoteTaskState::Queued {
                RemoteTaskState::Failed
            } else {
                RemoteTaskState::Cancelled
            };
            let error = RemoteTaskError {
                code: RemoteTaskFailureCode::AuthenticationFailed,
                message: "device access was revoked".to_owned(),
                retryable: false,
            };
            if let Ok(snapshot) = self.transition_internal(&task_id, next_state, Some(error)) {
                revoked.push(snapshot);
            }
        }
        revoked
    }

    pub fn fail_all(
        &self,
        code: RemoteTaskFailureCode,
        message: impl Into<String>,
    ) -> Vec<RemoteTaskSnapshot> {
        let task_ids = {
            let inner = self.lock_inner();
            inner
                .tasks
                .iter()
                .filter(|(_, record)| !record.snapshot.state.is_terminal())
                .map(|(task_id, _)| task_id.clone())
                .collect::<Vec<_>>()
        };
        let message = message.into();
        task_ids
            .into_iter()
            .filter_map(|task_id| {
                self.transition_internal(
                    &task_id,
                    RemoteTaskState::Failed,
                    Some(RemoteTaskError {
                        code: code.clone(),
                        message: message.clone(),
                        retryable: false,
                    }),
                )
                .ok()
            })
            .collect()
    }

    fn transition_internal(
        &self,
        task_id: &str,
        next_state: RemoteTaskState,
        error: Option<RemoteTaskError>,
    ) -> Result<RemoteTaskSnapshot, TaskManagerError> {
        let now = self.clock.now();
        let mut inner = self.lock_inner();
        let current = inner
            .tasks
            .get(task_id)
            .ok_or(TaskManagerError::TaskNotFound)?
            .snapshot
            .state
            .clone();
        if current.is_terminal() {
            return Err(TaskManagerError::AlreadyTerminal);
        }
        if !can_transition_remote_task(&current, &next_state) {
            return Err(TaskManagerError::InvalidTransition {
                from: current,
                to: next_state,
            });
        }
        if next_state.is_active() && inner.active_task_id.as_deref() != Some(task_id) {
            return Err(TaskManagerError::ActiveTaskExists);
        }
        let owner_device_id = inner
            .tasks
            .get(task_id)
            .expect("task existence checked above")
            .snapshot
            .owner_device_id
            .clone();
        let terminal = next_state.terminal_state();
        let snapshot = {
            let record = inner
                .tasks
                .get_mut(task_id)
                .expect("task existence checked above");
            record.snapshot.state = next_state.clone();
            record.snapshot.updated_at = now.timestamp.clone();
            if next_state == RemoteTaskState::Running && record.snapshot.started_at.is_none() {
                record.snapshot.started_at = Some(now.timestamp.clone());
            }
            if terminal.is_some() {
                record.snapshot.finished_at = Some(now.timestamp.clone());
            }
            record.snapshot.error = error.clone();
            record.snapshot.clone()
        };
        if terminal.is_some() && inner.active_task_id.as_deref() == Some(task_id) {
            inner.active_task_id = None;
        }
        if terminal.is_some() && current == RemoteTaskState::Queued {
            inner.queue.retain(|queued| queued != task_id);
        }
        drop(inner);
        if let Some(terminal) = terminal {
            self.event_hub.publish(
                &owner_device_id,
                now.timestamp,
                EventPayload::TaskCompleted {
                    task_id: task_id.to_owned(),
                    state: terminal,
                    error,
                },
            );
        } else {
            self.event_hub.publish(
                &owner_device_id,
                now.timestamp,
                EventPayload::TaskStateChanged {
                    task_id: task_id.to_owned(),
                    from: current,
                    to: next_state,
                    error,
                },
            );
        }
        Ok(snapshot)
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, TaskManagerInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn request_fingerprint(request: &RemoteTaskCreateRequest) -> u64 {
    let mut hasher = DefaultHasher::new();
    request.request_id.hash(&mut hasher);
    request.project_id.hash(&mut hasher);
    request.prompt.hash(&mut hasher);
    request.execution_profile.hash(&mut hasher);
    for file in &request.context_files {
        file.relative_path.hash(&mut hasher);
    }
    hasher.finish()
}

trait TaskStateExt {
    fn is_active(&self) -> bool;
    fn is_terminal(&self) -> bool;
    fn terminal_state(&self) -> Option<RemoteTaskTerminalState>;
}

impl TaskStateExt for RemoteTaskState {
    fn is_active(&self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::AwaitingInput)
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Cancelled)
    }

    fn terminal_state(&self) -> Option<RemoteTaskTerminalState> {
        match self {
            Self::Succeeded => Some(RemoteTaskTerminalState::Succeeded),
            Self::Failed => Some(RemoteTaskTerminalState::Failed),
            Self::Cancelled => Some(RemoteTaskTerminalState::Cancelled),
            _ => None,
        }
    }
}

impl From<AuthorizationError> for TaskManagerError {
    fn from(_: AuthorizationError) -> Self {
        Self::Unauthorized
    }
}

/// Crate-wide ISO-8601 rendering for unix-millisecond timestamps
/// (`YYYY-MM-DDTHH:MM:SS.mmmZ`, UTC). Contract DTOs type every timestamp as
/// `IsoTimestamp`, so all server-owned snapshots and events must use this.
pub fn format_timestamp(unix_ms: u64) -> String {
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
