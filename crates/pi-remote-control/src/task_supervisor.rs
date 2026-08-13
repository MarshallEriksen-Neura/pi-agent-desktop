//! Trusted local supervisor for remote tasks.
//!
//! The supervisor is the only bridge from the HTTP task queue to a Pi
//! process.  It owns the single active runtime lease, revalidates the
//! project allowlist immediately before launch, and keeps mobile connection
//! lifetime out of task lifetime.

use crate::event_hub::{EventHub, EventPayload};
use crate::interaction::InteractionManager;
use crate::principal::Principal;
use crate::project_catalog::ProjectCatalog;
use crate::protocol::{
    RemoteInteractionRequest, RemoteTaskError, RemoteTaskFailureCode, RemoteTaskState,
};
use crate::storage::{IdempotencyRecord, RemoteStorage};
use crate::task_manager::{ClaimedTask, TaskManager};
use crate::task_runtime::{
    RemoteTaskInput, RemoteTaskResponse, RemoteTaskRuntime, RemoteTaskRuntimeConfig, RuntimeEvent,
    RuntimeOutputStream, RuntimeTerminal,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const SUPERVISOR_POLL: Duration = Duration::from_millis(25);

pub struct TaskSupervisor {
    tasks: Arc<TaskManager>,
    projects: Arc<ProjectCatalog>,
    interactions: Arc<InteractionManager>,
    event_hub: Arc<EventHub>,
    storage: Option<Arc<RemoteStorage>>,
    runtime_config: RemoteTaskRuntimeConfig,
    active: Mutex<HashMap<String, Arc<RemoteTaskRuntime>>>,
    stopping: AtomicBool,
    task_workers: AtomicUsize,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl TaskSupervisor {
    pub fn new(
        tasks: Arc<TaskManager>,
        projects: Arc<ProjectCatalog>,
        interactions: Arc<InteractionManager>,
        event_hub: Arc<EventHub>,
        storage: Option<Arc<RemoteStorage>>,
        runtime_config: RemoteTaskRuntimeConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            tasks,
            projects,
            interactions,
            event_hub,
            storage,
            runtime_config,
            active: Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            task_workers: AtomicUsize::new(0),
            worker: Mutex::new(None),
        })
    }

    pub fn start(self: &Arc<Self>) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return;
        }
        let supervisor = Arc::downgrade(self);
        *worker = thread::Builder::new()
            .name("remote-task-supervisor".to_owned())
            .spawn(move || Self::run_loop(supervisor))
            .ok();
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.cancel_all();
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }

    pub fn wait_for_idle(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while (self.active_len() != 0 || self.task_workers.load(Ordering::Acquire) != 0)
            && std::time::Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(25));
        }
        self.active_len() == 0 && self.task_workers.load(Ordering::Acquire) == 0
    }

    pub fn active_len(&self) -> usize {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    pub fn persist_task(&self, owner: &str, task_id: &str) {
        self.persist_latest_event(owner, task_id);
    }

    pub fn cancel(&self, task_id: &str) -> bool {
        let runtime = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(task_id)
            .cloned();
        if let Some(runtime) = runtime {
            runtime.cancel();
            true
        } else {
            false
        }
    }

    pub fn cancel_all(&self) {
        let runtimes = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for runtime in runtimes {
            runtime.cancel();
        }
    }

    pub fn cancel_project(&self, project_id: &str) {
        let task_ids = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .filter(|task_id| {
                self.tasks
                    .request(task_id)
                    .map_or(false, |request| request.project_id == project_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for task_id in task_ids {
            self.cancel(&task_id);
        }
    }

    pub fn cancel_owner(&self, owner_device_id: &str) {
        let task_ids = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .filter(|task_id| {
                self.tasks.owner_device_id(task_id).as_deref() == Some(owner_device_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for task_id in task_ids {
            self.cancel(&task_id);
        }
    }

    pub fn respond(
        &self,
        response: RemoteTaskResponse,
    ) -> Result<(), crate::task_runtime::RuntimeError> {
        let runtime = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .find(|runtime| runtime.respond(response.clone()).is_ok())
            .cloned();
        if runtime.is_some() {
            Ok(())
        } else {
            Err(crate::task_runtime::RuntimeError::ResponseRejected)
        }
    }

    fn run_loop(weak: Weak<Self>) {
        while let Some(supervisor) = weak.upgrade() {
            if supervisor.stopping.load(Ordering::Acquire) {
                break;
            }
            if supervisor.active_len() == 0 {
                if let Some(claim) = supervisor.tasks.claim_next() {
                    supervisor.launch(claim);
                }
            }
            thread::sleep(SUPERVISOR_POLL);
        }
    }

    fn launch(self: &Arc<Self>, claim: ClaimedTask) {
        let owner = claim.snapshot.owner_device_id.clone();
        let task_id = claim.snapshot.task_id.clone();
        let root = match self
            .projects
            .revalidate_runtime_context(&claim.request.project_id, &claim.request.context_files)
        {
            Ok(root) => root,
            Err(error) => {
                self.fail_task(
                    &task_id,
                    &owner,
                    RemoteTaskFailureCode::ProjectUnavailable,
                    error.to_string(),
                );
                return;
            }
        };
        let input = RemoteTaskInput {
            task_id: task_id.clone(),
            project_root: root,
            prompt: claim.request.prompt.clone(),
            context_files: claim.request.context_files.clone(),
        };
        let supervisor = Arc::clone(self);
        let event_owner = owner.clone();
        let event_task_id = task_id.clone();
        let event_sink = move |event| supervisor.handle_event(&event_owner, &event_task_id, event);
        let runtime = match RemoteTaskRuntime::start(input, self.runtime_config.clone(), event_sink)
        {
            Ok(runtime) => Arc::new(runtime),
            Err(error) => {
                self.fail_task(
                    &task_id,
                    &owner,
                    if matches!(error, crate::task_runtime::RuntimeError::InvalidContext) {
                        RemoteTaskFailureCode::InvalidContext
                    } else {
                        RemoteTaskFailureCode::ProcessFailed
                    },
                    error.to_string(),
                );
                return;
            }
        };
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(task_id.clone(), Arc::clone(&runtime));
        let principal = match Principal::v1(owner.clone(), 0) {
            Ok(principal) => principal,
            Err(_) => {
                runtime.cancel();
                self.active
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&task_id);
                self.fail_task(
                    &task_id,
                    &owner,
                    RemoteTaskFailureCode::ProcessFailed,
                    "task owner identity is invalid".to_owned(),
                );
                return;
            }
        };
        if self
            .tasks
            .transition_owned(&principal, &task_id, RemoteTaskState::Running, None)
            .is_err()
        {
            runtime.cancel();
        }
        self.persist_latest_event(&owner, &task_id);
        let supervisor = Arc::clone(self);
        let thread_task_id = task_id.clone();
        let thread_owner = owner.clone();
        self.task_workers.fetch_add(1, Ordering::AcqRel);
        if thread::Builder::new()
            .name(format!("remote-task-{task_id}"))
            .spawn(move || {
                let outcome = runtime.wait(Duration::from_secs(60 * 60 + 10)).ok();
                supervisor.finish(
                    &thread_task_id,
                    &thread_owner,
                    outcome.map(|value| value.terminal),
                );
                supervisor.task_workers.fetch_sub(1, Ordering::AcqRel);
            })
            .is_err()
        {
            self.task_workers.fetch_sub(1, Ordering::AcqRel);
            self.finish(&task_id, &owner, None);
        }
    }

    fn handle_event(&self, owner: &str, task_id: &str, event: RuntimeEvent) {
        match event {
            RuntimeEvent::Output { stream, fragment } => {
                let published = self.event_hub.publish(
                    owner,
                    timestamp_now(),
                    EventPayload::TaskOutputAppended {
                        task_id: task_id.to_owned(),
                        fragment,
                        stream: match stream {
                            RuntimeOutputStream::Stdout => "stdout".to_owned(),
                            RuntimeOutputStream::Stderr => "stderr".to_owned(),
                            RuntimeOutputStream::Tool => "tool".to_owned(),
                        },
                    },
                );
                if published.evicted_slow_consumers > 0 {
                    self.event_hub.publish(
                        owner,
                        timestamp_now(),
                        EventPayload::EventBackpressure {
                            task_id: task_id.to_owned(),
                            reason: "slow_subscriber_evicted".to_owned(),
                        },
                    );
                }
                self.persist_latest_event(owner, task_id);
            }
            RuntimeEvent::OutputTruncated { dropped } => {
                self.event_hub.publish(
                    owner,
                    timestamp_now(),
                    EventPayload::TaskOutputAppended {
                        task_id: task_id.to_owned(),
                        fragment: format!("[output truncated: {dropped} fragments dropped]"),
                        stream: "meta".to_owned(),
                    },
                );
                self.persist_latest_event(owner, task_id);
            }
            RuntimeEvent::InteractionRequested(request) => {
                self.create_interaction(owner, task_id, request);
            }
            RuntimeEvent::Diagnostic { code } if code == "event_backpressure" => {
                self.event_hub.publish(
                    owner,
                    timestamp_now(),
                    EventPayload::EventBackpressure {
                        task_id: task_id.to_owned(),
                        reason: code.to_owned(),
                    },
                );
            }
            RuntimeEvent::ProtocolState { event_type } => {
                self.event_hub.publish(
                    owner,
                    timestamp_now(),
                    EventPayload::TaskChanges {
                        task_id: task_id.to_owned(),
                        revision: protocol_revision(&event_type),
                    },
                );
            }
            RuntimeEvent::Diagnostic { .. } | RuntimeEvent::Terminal { .. } => {}
        }
    }

    fn create_interaction(&self, owner: &str, task_id: &str, request: RemoteInteractionRequest) {
        let principal = match Principal::v1(owner.to_owned(), 0) {
            Ok(principal) => principal,
            Err(_) => return,
        };
        if self.interactions.create(&principal, request).is_ok() {
            self.persist_latest_event(owner, task_id);
            let _ = self.tasks.transition_owned(
                &principal,
                task_id,
                RemoteTaskState::AwaitingInput,
                None,
            );
            self.persist_latest_event(owner, task_id);
        }
    }

    fn finish(&self, task_id: &str, owner: &str, terminal: Option<RuntimeTerminal>) {
        let Some(terminal) = terminal else {
            self.fail_task(
                task_id,
                owner,
                RemoteTaskFailureCode::ProcessFailed,
                "runtime did not return an outcome".to_owned(),
            );
            self.remove_active(task_id);
            return;
        };
        let (state, error) = match terminal {
            RuntimeTerminal::Succeeded => (RemoteTaskState::Succeeded, None),
            RuntimeTerminal::Cancelled => (
                RemoteTaskState::Cancelled,
                Some(task_error(
                    RemoteTaskFailureCode::Cancelled,
                    "task cancelled",
                )),
            ),
            RuntimeTerminal::TimedOut => (
                RemoteTaskState::Failed,
                Some(task_error(
                    RemoteTaskFailureCode::Timeout,
                    "task deadline exceeded",
                )),
            ),
            RuntimeTerminal::EventBackpressure => (
                RemoteTaskState::Failed,
                Some(task_error(
                    RemoteTaskFailureCode::EventBackpressure,
                    "runtime event lane saturated",
                )),
            ),
            RuntimeTerminal::Failed { code } => (
                RemoteTaskState::Failed,
                Some(task_error(RemoteTaskFailureCode::ProcessFailed, code)),
            ),
        };
        let principal = match Principal::v1(owner.to_owned(), 0) {
            Ok(principal) => principal,
            Err(_) => {
                self.remove_active(task_id);
                return;
            }
        };
        let _ = self
            .tasks
            .transition_owned(&principal, task_id, state, error);
        self.persist_latest_event(owner, task_id);
        self.remove_active(task_id);
    }

    fn remove_active(&self, task_id: &str) {
        self.active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(task_id);
    }

    fn fail_task(&self, task_id: &str, owner: &str, code: RemoteTaskFailureCode, message: String) {
        let principal = match Principal::v1(owner.to_owned(), 0) {
            Ok(principal) => principal,
            Err(_) => return,
        };
        let _ = self.tasks.transition_owned(
            &principal,
            task_id,
            RemoteTaskState::Failed,
            Some(task_error(code, &message)),
        );
        self.persist_latest_event(owner, task_id);
    }

    fn persist_latest_event(&self, owner: &str, task_id: &str) {
        let Some(storage) = &self.storage else {
            return;
        };
        let Some(request) = self.tasks.request(task_id) else {
            return;
        };
        let idempotency = self.tasks.idempotency_record(task_id).map(
            |(device_id, request_id, fingerprint, expires_at_ms)| IdempotencyRecord {
                device_id,
                request_id,
                task_id: task_id.to_owned(),
                fingerprint,
                expires_at_ms,
            },
        );
        let Some(snapshot) = Principal::v1(owner.to_owned(), 0)
            .ok()
            .and_then(|principal| self.tasks.snapshot(&principal, task_id).ok())
        else {
            return;
        };
        let Some(event) = self
            .event_hub
            .replay(owner, None, &timestamp_now())
            .events
            .into_iter()
            .rev()
            .find(|event| event_task_id(event) == Some(task_id))
        else {
            return;
        };
        let stored = crate::storage::StoredEvent {
            device_id: owner.to_owned(),
            sequence: event_sequence(&event),
            event_id: event_id(&event).to_owned(),
            emitted_at_ms: now_ms(),
            payload: event,
        };
        let _ = storage.commit_task_event_with_request(
            &snapshot,
            &stored,
            idempotency.as_ref(),
            Some(&request),
        );
    }
}

fn task_error(code: RemoteTaskFailureCode, message: impl Into<String>) -> RemoteTaskError {
    RemoteTaskError {
        code,
        message: message.into(),
        retryable: false,
    }
}

fn protocol_revision(event_type: &str) -> u64 {
    let mut value = 1469598103934665603_u64;
    for byte in event_type.as_bytes() {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(1099511628211);
    }
    value
}

fn timestamp_now() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let seconds = millis / 1000;
    let day_count = seconds / 86_400;
    let z = day_count as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let month_prime = (5 * doy + 2) / 153;
    let day = doy - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    let day_seconds = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3600,
        (day_seconds % 3600) / 60,
        day_seconds % 60,
        millis % 1000
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn event_sequence(event: &crate::protocol::RemoteEvent) -> u64 {
    event_base(event).sequence
}

fn event_id(event: &crate::protocol::RemoteEvent) -> &str {
    &event_base(event).event_id
}

fn event_base(event: &crate::protocol::RemoteEvent) -> &crate::protocol::RemoteEventBase {
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
        | crate::protocol::RemoteEvent::EventBackpressure { base, .. } => base,
    }
}

fn event_task_id(event: &crate::protocol::RemoteEvent) -> Option<&str> {
    match event {
        crate::protocol::RemoteEvent::TaskCreated { task, .. } => Some(&task.task_id),
        crate::protocol::RemoteEvent::TaskStateChanged { task_id, .. }
        | crate::protocol::RemoteEvent::TaskOutputAppended { task_id, .. }
        | crate::protocol::RemoteEvent::TaskCompleted { task_id, .. }
        | crate::protocol::RemoteEvent::TaskChanges { task_id, .. }
        | crate::protocol::RemoteEvent::InteractionRequested { task_id, .. }
        | crate::protocol::RemoteEvent::InteractionResolved { task_id, .. }
        | crate::protocol::RemoteEvent::InteractionExpired { task_id, .. }
        | crate::protocol::RemoteEvent::EventBackpressure { task_id, .. } => Some(task_id),
        crate::protocol::RemoteEvent::SnapshotRequired { .. } => None,
    }
}
