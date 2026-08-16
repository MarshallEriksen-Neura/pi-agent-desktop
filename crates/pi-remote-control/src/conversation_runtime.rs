//! Conversation runtime manager.
//!
//! Schedules durable conversation turns through the probe-gated private
//! [`PiSessionAdapter`]. At most one turn executes globally at a time;
//! accepted intent stays queued in storage until dispatched. Warm sessions
//! are evicted after a bounded idle window because the persisted session —
//! never the child process — is the source of context continuity.

use crate::conversation_protocol::{
    RemoteConversationError, RemoteConversationErrorCode, RemoteConversationEvent,
    RemoteConversationEventBase, RemoteMessageDeltaEvent, RemoteTurnTerminalState,
    REMOTE_CONVERSATION_GLOBAL_ACTIVE_TURNS, REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES,
};
use crate::pi_session::{
    PiSessionAdapter, PiSessionBinding, PiSessionContext, PiSessionError, PiSessionHandle,
    PiTurnStreamEvent,
};
use crate::observability::V2Metrics;
use crate::project_catalog::ProjectCatalog;
use crate::storage::{
    ConversationSessionRecord, DispatchableTurn, RemoteStorage, StorageError, TurnCompletionInput,
    TurnExecutionInput,
};
use pi_backend_core::pi_process::PiProcess;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_WARM_IDLE_WINDOW: Duration = Duration::from_secs(120);
pub const DEFAULT_CONVERSATION_POLL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug)]
pub struct ConversationRuntimeConfig {
    pub warm_idle_window: Duration,
    pub poll_interval: Duration,
}

impl Default for ConversationRuntimeConfig {
    fn default() -> Self {
        Self {
            warm_idle_window: DEFAULT_WARM_IDLE_WINDOW,
            poll_interval: DEFAULT_CONVERSATION_POLL,
        }
    }
}

/// Result of one synchronous dispatch attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// Nothing dispatchable right now.
    Empty,
    /// The global one-active-turn cap is already reached.
    ActiveLimit,
    /// A turn reached a terminal state through this dispatch.
    Completed {
        conversation_id: String,
        turn_id: String,
        terminal: RemoteTurnTerminalState,
    },
    /// A turn paused for an extension interaction; resolution arrives later.
    AwaitingInput {
        conversation_id: String,
        turn_id: String,
    },
    /// Session start/resume failed closed; the turn failed without replay.
    SessionUnavailable {
        conversation_id: String,
        turn_id: String,
    },
    /// The project is not allowlisted anymore; the turn failed closed.
    ProjectRevoked {
        conversation_id: String,
        turn_id: String,
    },
}

struct WarmSession {
    handle: PiSessionHandle,
    last_active: Instant,
}

struct ActiveExecution {
    owner_device_id: String,
    conversation_id: String,
    turn_id: String,
    process: Arc<PiProcess>,
    cancel_requested: AtomicBool,
}

pub struct ConversationRuntimeManager {
    storage: Arc<RemoteStorage>,
    projects: Arc<ProjectCatalog>,
    adapter: Arc<PiSessionAdapter>,
    config: ConversationRuntimeConfig,
    warm: Mutex<HashMap<String, WarmSession>>,
    executing: Mutex<Option<ActiveExecution>>,
    stopping: AtomicBool,
    worker: Mutex<Option<JoinHandle<()>>>,
    metrics: Arc<V2Metrics>,
}

impl ConversationRuntimeManager {
    pub fn new(
        storage: Arc<RemoteStorage>,
        projects: Arc<ProjectCatalog>,
        adapter: Arc<PiSessionAdapter>,
        config: ConversationRuntimeConfig,
    ) -> Arc<Self> {
        Arc::new(Self {
            storage,
            projects,
            adapter,
            config,
            warm: Mutex::new(HashMap::new()),
            executing: Mutex::new(None),
            stopping: AtomicBool::new(false),
            worker: Mutex::new(None),
            metrics: Arc::new(V2Metrics::default()),
        })
    }

    pub fn metrics(&self) -> Arc<V2Metrics> {
        Arc::clone(&self.metrics)
    }

    /// Starts the background dispatch loop.
    pub fn start(self: &Arc<Self>) {
        let mut worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if worker.is_some() {
            return;
        }
        let manager = Arc::downgrade(self);
        *worker = thread::Builder::new()
            .name("conversation-runtime".to_owned())
            .spawn(move || Self::run_loop(manager))
            .ok();
    }

    /// Stops the loop, joins the worker, and evicts every warm child. The
    /// persisted sessions keep context continuity across the stop.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        let worker = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(worker) = worker {
            let _ = worker.join();
        }
        let mut warm = self
            .warm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (_, session) in warm.drain() {
            let _ = session.handle.shutdown();
        }
    }

    pub fn wait_for_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let idle = self
                .executing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_none();
            if idle {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn run_loop(manager: Weak<Self>) {
        while let Some(manager) = manager.upgrade() {
            if manager.stopping.load(Ordering::Acquire) {
                break;
            }
            let poll = manager.config.poll_interval;
            let _ = manager.dispatch_next();
            drop(manager);
            thread::sleep(poll);
        }
    }

    /// Currently executing turn, if any: `(owner, conversation, turn)`.
    pub fn active_execution(&self) -> Option<(String, String, String)> {
        let executing = self
            .executing
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        executing.as_ref().map(|active| {
            (
                active.owner_device_id.clone(),
                active.conversation_id.clone(),
                active.turn_id.clone(),
            )
        })
    }

    /// Stops an active turn, archives durable conversation state, and removes
    /// the gateway-private session directory. Archive is intentionally owned
    /// by the runtime manager so route handlers cannot forget process cleanup.
    pub fn archive_conversation(&self, owner_device_id: &str, conversation_id: &str) -> bool {
        let snapshot = match self.storage.load_conversation(owner_device_id, conversation_id) {
            Ok(Some(snapshot)) => snapshot,
            _ => return false,
        };
        if let Some((owner, conversation, turn)) = self.active_execution() {
            if owner == owner_device_id && conversation == conversation_id {
                let _ = self.cancel_turn(owner_device_id, conversation_id, &turn);
            }
        }
        let changed = self
            .storage
            .archive_conversation(owner_device_id, conversation_id, clock_now().0)
            .unwrap_or(false);
        if changed {
            if let Ok(project_root) = self.projects.runtime_project_root(&snapshot.project_id) {
                let context = PiSessionContext {
                    owner_device_id: owner_device_id.to_owned(),
                    conversation_id: conversation_id.to_owned(),
                    project_id: snapshot.project_id,
                    project_root,
                };
                let _ = self.adapter.remove_conversation_session(&context);
            }
            let mut warm = self
                .warm
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(session) = warm.remove(conversation_id) {
                let _ = session.handle.shutdown();
            }
        }
        changed
    }

    pub fn warm_session_count(&self) -> usize {
        self.warm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// Evicts warm sessions idle beyond the bounded window. Eviction is
    /// always safe: cold resume through the stored binding is the recovery
    /// path.
    pub fn evict_expired_warm(&self) {
        let mut warm = self
            .warm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let window = self.config.warm_idle_window;
        let expired: Vec<String> = warm
            .iter()
            .filter(|(_, session)| session.last_active.elapsed() >= window)
            .map(|(conversation_id, _)| conversation_id.clone())
            .collect();
        for conversation_id in expired {
            if let Some(session) = warm.remove(&conversation_id) {
                let _ = session.handle.shutdown();
            }
        }
    }

    /// One synchronous dispatch cycle: evict, check the global active cap,
    /// claim the oldest dispatchable turn, and execute it.
    pub fn dispatch_next(&self) -> DispatchOutcome {
        self.evict_expired_warm();
        let active = self.storage.count_active_turns().unwrap_or(u64::MAX);
        if active >= u64::from(REMOTE_CONVERSATION_GLOBAL_ACTIVE_TURNS) {
            return DispatchOutcome::ActiveLimit;
        }
        let Some(dispatchable) = self.storage.next_dispatchable_turn().unwrap_or(None) else {
            return DispatchOutcome::Empty;
        };
        self.execute_turn(&dispatchable)
    }

    fn execute_turn(&self, dispatchable: &DispatchableTurn) -> DispatchOutcome {
        let owner = &dispatchable.owner_device_id;
        let conversation = &dispatchable.conversation_id;
        let turn = &dispatchable.turn_id;

        // Revalidate the project allowlist immediately before launch.
        let project_root = match self.projects.runtime_project_root(&dispatchable.project_id) {
            Ok(root) => root,
            Err(_) => {
                let _ = self.complete_failed(
                    dispatchable,
                    RemoteConversationErrorCode::ProjectRevoked,
                    "project access is not available",
                    true,
                );
                let (unavailable_at_ms, unavailable_at) = clock_now();
                let _ = self.storage.mark_conversation_unavailable(
                    owner,
                    conversation,
                    unavailable_at_ms,
                    &unavailable_at,
                    &format!("rt-unavailable-{turn}"),
                );
                return DispatchOutcome::ProjectRevoked {
                    conversation_id: conversation.clone(),
                    turn_id: turn.clone(),
                };
            }
        };

        let context = PiSessionContext {
            owner_device_id: owner.clone(),
            conversation_id: conversation.clone(),
            project_id: dispatchable.project_id.clone(),
            project_root,
        };

        // Session acquisition: warm hit > stored-binding cold resume > start.
        let has_stored_binding = self
            .storage
            .load_conversation_session(owner, conversation)
            .ok()
            .flatten()
            .is_some();
        let mut handle = match self.acquire_session(dispatchable, &context) {
            Ok(handle) => handle,
            Err(_) => {
                if has_stored_binding {
                    self.metrics.inc_resume_failure();
                }
                let _ = self.complete_failed(
                    dispatchable,
                    RemoteConversationErrorCode::SessionResumeUnavailable,
                    "session resume is unavailable",
                    true,
                );
                let (unavailable_at_ms, unavailable_at) = clock_now();
                let _ = self.storage.mark_conversation_unavailable(
                    owner,
                    conversation,
                    unavailable_at_ms,
                    &unavailable_at,
                    &format!("rt-unavailable-{turn}"),
                );
                return DispatchOutcome::SessionUnavailable {
                    conversation_id: conversation.clone(),
                    turn_id: turn.clone(),
                };
            }
        };
        if has_stored_binding {
            self.metrics.inc_resume_success();
        }

        let (at_ms, at) = clock_now();
        if self
            .storage
            .mark_turn_started(&TurnExecutionInput {
                owner_device_id: owner.clone(),
                conversation_id: conversation.clone(),
                turn_id: turn.clone(),
                at_ms,
                at,
                event_id: format!("rt-start-{turn}"),
            })
            .is_err()
        {
            // The turn is no longer dispatchable (cancelled in a race); park
            // the session warm and let the next cycle pick fresh work.
            self.park_warm(conversation, handle);
            return DispatchOutcome::Empty;
        }
        let (at_ms, at) = clock_now();
        let _ = self.storage.mark_turn_running(&TurnExecutionInput {
            owner_device_id: owner.clone(),
            conversation_id: conversation.clone(),
            turn_id: turn.clone(),
            at_ms,
            at,
            event_id: format!("rt-running-{turn}"),
        });

        // Verify the per-turn model binding before any prompt delivery. A
        // mismatch fails the turn closed with a stable redacted error; it
        // never silently falls back to another model.
        if let Some(model_ref) = dispatchable.model_ref.as_deref() {
            if handle.set_model(model_ref).is_err() {
                drop(handle);
                let _ = self.complete_failed(
                    dispatchable,
                    RemoteConversationErrorCode::ModelUnavailable,
                    "model selection failed before delivery",
                    false,
                );
                return DispatchOutcome::Completed {
                    conversation_id: conversation.clone(),
                    turn_id: turn.clone(),
                    terminal: RemoteTurnTerminalState::Failed,
                };
            }
        }

        let process = handle.process_handle();
        {
            let mut executing = self
                .executing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *executing = Some(ActiveExecution {
                owner_device_id: owner.clone(),
                conversation_id: conversation.clone(),
                turn_id: turn.clone(),
                process,
                cancel_requested: AtomicBool::new(false),
            });
        }
        let result = {
            // Live-lane forwarding: each streamed text fragment becomes a
            // durable message.delta event in the outbox, so remote clients
            // render the reply progressively instead of after the turn ends.
            // The message id matches the terminal assistant message committed
            // by complete_turn, so a reconnect/replay converges cleanly.
            let mut delta_index: u64 = 0;
            let mut streamed_bytes: usize = 0;
            handle.run_turn_with_stream(&dispatchable.prompt, |stream_event| {
                let PiTurnStreamEvent::TextDelta(delta) = stream_event;
                if streamed_bytes >= REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES {
                    return;
                }
                streamed_bytes = streamed_bytes.saturating_add(delta.len());
                delta_index += 1;
                let (at_ms, at) = clock_now();
                let event_id = format!("rt-delta-{turn}-{delta_index}");
                let _ = self.storage.append_streaming_conversation_event(
                    &owner,
                    &event_id,
                    at_ms,
                    |sequence| {
                        RemoteConversationEvent::MessageDelta(RemoteMessageDeltaEvent {
                            base: RemoteConversationEventBase {
                                event_id: event_id.clone(),
                                emitted_at: at.clone(),
                                sequence,
                                device_id: owner.clone(),
                                conversation_id: conversation.clone(),
                            },
                            turn_id: turn.clone(),
                            message_id: format!("assistant-{turn}"),
                            delta,
                        })
                    },
                );
            })
        };
        let cancel_requested = {
            let mut executing = self
                .executing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let flag = executing
                .as_ref()
                .map(|active| active.cancel_requested.load(Ordering::Acquire))
                .unwrap_or(false);
            *executing = None;
            flag
        };

        // Persist the refreshed private binding before the terminal commit.
        if let Some(state) = handle.state() {
            let probe = self.adapter.probe_info();
            let (updated_at_ms, _) = clock_now();
            let _ = self
                .storage
                .store_conversation_session(&ConversationSessionRecord {
                    owner_device_id: owner.clone(),
                    conversation_id: conversation.clone(),
                    session_id: state.binding.session_id_for_storage().to_owned(),
                    relative_ref: state.binding.relative_ref_for_storage().to_owned(),
                    pi_version: probe.pi_version.clone(),
                    format_fingerprint: probe.format_fingerprint.clone(),
                    state: "bound".into(),
                    updated_at_ms,
                });
        }

        match result {
            Ok(outcome) => {
                // The session is healthy: park it warm within the bounded
                // idle window.
                self.park_warm(conversation, handle);
                if cancel_requested {
                    let _ = self.complete_cancelled(dispatchable);
                    return DispatchOutcome::Completed {
                        conversation_id: conversation.clone(),
                        turn_id: turn.clone(),
                        terminal: RemoteTurnTerminalState::Cancelled,
                    };
                }
                if outcome.interaction_requested {
                    let (at_ms, at) = clock_now();
                    let _ = self.storage.mark_turn_awaiting_input(&TurnExecutionInput {
                        owner_device_id: owner.clone(),
                        conversation_id: conversation.clone(),
                        turn_id: turn.clone(),
                        at_ms,
                        at,
                        event_id: format!("rt-awaiting-{turn}"),
                    });
                    return DispatchOutcome::AwaitingInput {
                        conversation_id: conversation.clone(),
                        turn_id: turn.clone(),
                    };
                }
                let (at_ms, at) = clock_now();
                let _ = self.storage.complete_turn(&TurnCompletionInput {
                    owner_device_id: owner.clone(),
                    conversation_id: conversation.clone(),
                    turn_id: turn.clone(),
                    terminal: RemoteTurnTerminalState::Succeeded,
                    error: None,
                    assistant_message_id: Some(format!("assistant-{turn}")),
                    assistant_text: Some(outcome.assistant_text),
                    mark_delivery_failed: false,
                    at_ms,
                    at,
                    state_changed_event_id: format!("rt-state-{turn}"),
                    completed_event_id: format!("rt-completed-{turn}"),
                    message_completed_event_id: format!("rt-message-{turn}"),
                    status_changed_event_id: format!("rt-status-{turn}"),
                });
                DispatchOutcome::Completed {
                    conversation_id: conversation.clone(),
                    turn_id: turn.clone(),
                    terminal: RemoteTurnTerminalState::Succeeded,
                }
            }
            Err(_) => {
                // Execution failed or the process was killed mid-turn: do not
                // keep the child warm; the next turn cold-resumes through the
                // stored binding with full revalidation.
                drop(handle);
                if cancel_requested {
                    let _ = self.complete_cancelled(dispatchable);
                    DispatchOutcome::Completed {
                        conversation_id: conversation.clone(),
                        turn_id: turn.clone(),
                        terminal: RemoteTurnTerminalState::Cancelled,
                    }
                } else {
                    let _ = self.complete_failed(
                        dispatchable,
                        RemoteConversationErrorCode::ProcessFailed,
                        "turn execution failed",
                        false,
                    );
                    DispatchOutcome::Completed {
                        conversation_id: conversation.clone(),
                        turn_id: turn.clone(),
                        terminal: RemoteTurnTerminalState::Failed,
                    }
                }
            }
        }
    }

    /// Session acquisition order: warm hit, then cold resume through the
    /// stored binding, then a fresh start. Every path is probe-gated and
    /// revalidated inside the adapter.
    fn acquire_session(
        &self,
        dispatchable: &DispatchableTurn,
        context: &PiSessionContext,
    ) -> Result<PiSessionHandle, PiSessionError> {
        if let Some(session) = self
            .warm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&dispatchable.conversation_id)
        {
            return Ok(session.handle);
        }
        if let Ok(Some(record)) = self
            .storage
            .load_conversation_session(&dispatchable.owner_device_id, &dispatchable.conversation_id)
        {
            let binding = PiSessionBinding::from_storage(
                record.relative_ref,
                record.session_id,
                dispatchable.owner_device_id.clone(),
                dispatchable.conversation_id.clone(),
                dispatchable.project_id.clone(),
                record.pi_version,
                record.format_fingerprint,
            );
            return self.adapter.resume(context.clone(), &binding);
        }
        self.adapter.start(context.clone())
    }

    fn park_warm(&self, conversation_id: &str, handle: PiSessionHandle) {
        self.warm
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                conversation_id.to_owned(),
                WarmSession {
                    handle,
                    last_active: Instant::now(),
                },
            );
    }

    /// Cancels one turn. The actively executing turn gets its process tree
    /// stopped and the dispatcher commits the cancelled terminal state;
    /// queued and awaiting-input turns are cancelled in storage. Cross-owner
    /// attempts fail exactly like invalid keys.
    pub fn cancel_turn(&self, owner_device_id: &str, conversation_id: &str, turn_id: &str) -> bool {
        let active_process = {
            let executing = self
                .executing
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match executing.as_ref() {
                Some(active)
                    if active.owner_device_id == owner_device_id
                        && active.conversation_id == conversation_id
                        && active.turn_id == turn_id =>
                {
                    active.cancel_requested.store(true, Ordering::Release);
                    Some(Arc::clone(&active.process))
                }
                _ => None,
            }
        };
        if let Some(process) = active_process {
            let _ = process.stop(Duration::from_secs(2));
            return true;
        }
        let (at_ms, at) = clock_now();
        self.storage
            .complete_turn(&TurnCompletionInput {
                owner_device_id: owner_device_id.to_owned(),
                conversation_id: conversation_id.to_owned(),
                turn_id: turn_id.to_owned(),
                terminal: RemoteTurnTerminalState::Cancelled,
                error: Some(RemoteConversationError {
                    code: RemoteConversationErrorCode::Cancelled,
                    message: "turn cancelled".to_owned(),
                    retryable: false,
                }),
                assistant_message_id: None,
                assistant_text: None,
                mark_delivery_failed: false,
                at_ms,
                at,
                state_changed_event_id: format!("rt-cancel-state-{turn_id}"),
                completed_event_id: format!("rt-cancel-completed-{turn_id}"),
                message_completed_event_id: format!("rt-cancel-message-{turn_id}"),
                status_changed_event_id: format!("rt-cancel-status-{turn_id}"),
            })
            .is_ok()
    }

    fn complete_failed(
        &self,
        dispatchable: &DispatchableTurn,
        code: RemoteConversationErrorCode,
        message: &str,
        mark_delivery_failed: bool,
    ) -> Result<(), StorageError> {
        let (at_ms, at) = clock_now();
        self.storage
            .complete_turn(&TurnCompletionInput {
                owner_device_id: dispatchable.owner_device_id.clone(),
                conversation_id: dispatchable.conversation_id.clone(),
                turn_id: dispatchable.turn_id.clone(),
                terminal: RemoteTurnTerminalState::Failed,
                error: Some(RemoteConversationError {
                    code,
                    message: message.to_owned(),
                    retryable: false,
                }),
                assistant_message_id: None,
                assistant_text: None,
                mark_delivery_failed,
                at_ms,
                at,
                state_changed_event_id: format!("rt-state-{}", dispatchable.turn_id),
                completed_event_id: format!("rt-completed-{}", dispatchable.turn_id),
                message_completed_event_id: format!("rt-message-{}", dispatchable.turn_id),
                status_changed_event_id: format!("rt-status-{}", dispatchable.turn_id),
            })
            .map(|_| ())
    }

    fn complete_cancelled(&self, dispatchable: &DispatchableTurn) -> Result<(), StorageError> {
        let (at_ms, at) = clock_now();
        self.storage
            .complete_turn(&TurnCompletionInput {
                owner_device_id: dispatchable.owner_device_id.clone(),
                conversation_id: dispatchable.conversation_id.clone(),
                turn_id: dispatchable.turn_id.clone(),
                terminal: RemoteTurnTerminalState::Cancelled,
                error: Some(RemoteConversationError {
                    code: RemoteConversationErrorCode::Cancelled,
                    message: "turn cancelled".to_owned(),
                    retryable: false,
                }),
                assistant_message_id: None,
                assistant_text: None,
                mark_delivery_failed: false,
                at_ms,
                at,
                state_changed_event_id: format!("rt-state-{}", dispatchable.turn_id),
                completed_event_id: format!("rt-completed-{}", dispatchable.turn_id),
                message_completed_event_id: format!("rt-message-{}", dispatchable.turn_id),
                status_changed_event_id: format!("rt-status-{}", dispatchable.turn_id),
            })
            .map(|_| ())
    }
}

fn clock_now() -> (u64, String) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    (ms, crate::task_manager::format_timestamp(ms))
}
