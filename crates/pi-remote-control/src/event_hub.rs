use crate::principal::{Principal, RemoteScope};
use crate::protocol::{
    RemoteEvent, RemoteEventBase, RemoteInteractionKind, RemoteInteractionResponse,
    RemoteTaskError, RemoteTaskSnapshot, RemoteTaskState, RemoteTaskTerminalState,
};
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

pub const MAX_REPLAY_CAPACITY: usize = 10_000;
pub const MAX_SUBSCRIBER_QUEUE: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventHubError {
    InvalidDeviceId,
    InvalidCapacity,
    SubscriberLimit,
}

impl fmt::Display for EventHubError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "event hub request is invalid")
    }
}

impl std::error::Error for EventHubError {}

#[derive(Debug, Clone)]
pub struct EventHubConfig {
    pub replay_capacity: usize,
    pub max_subscribers: usize,
}

impl Default for EventHubConfig {
    fn default() -> Self {
        Self {
            replay_capacity: 1024,
            max_subscribers: 16,
        }
    }
}

#[derive(Debug, Clone)]
pub enum EventPayload {
    TaskCreated(RemoteTaskSnapshot),
    TaskStateChanged {
        task_id: String,
        from: RemoteTaskState,
        to: RemoteTaskState,
        error: Option<RemoteTaskError>,
    },
    TaskOutputAppended {
        task_id: String,
        fragment: String,
        stream: String,
    },
    TaskCompleted {
        task_id: String,
        state: RemoteTaskTerminalState,
        error: Option<RemoteTaskError>,
    },
    TaskChanges {
        task_id: String,
        revision: u64,
    },
    InteractionRequested {
        interaction_id: String,
        task_id: String,
        interaction_kind: RemoteInteractionKind,
        prompt: String,
        expires_at: String,
    },
    InteractionResolved {
        interaction_id: String,
        task_id: String,
        response: RemoteInteractionResponse,
    },
    InteractionExpired {
        interaction_id: String,
        task_id: String,
    },
    SnapshotRequired {
        project_id: Option<String>,
    },
    EventBackpressure {
        task_id: String,
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub struct PublishedEvent {
    pub event: RemoteEvent,
    pub evicted_slow_consumers: usize,
}

#[derive(Debug, Clone)]
pub struct ReplayResult {
    pub events: Vec<RemoteEvent>,
    pub snapshot_required: bool,
}

pub struct EventSubscription {
    pub id: u64,
    pub device_id: String,
    receiver: Receiver<RemoteEvent>,
}

impl EventSubscription {
    pub fn try_recv(&self) -> Result<RemoteEvent, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn recv(&self) -> Result<RemoteEvent, mpsc::RecvError> {
        self.receiver.recv()
    }
}

struct Subscriber {
    device_id: String,
    sender: SyncSender<RemoteEvent>,
}

struct EventHubInner {
    next_sequence: HashMap<String, u64>,
    replay: HashMap<String, VecDeque<RemoteEvent>>,
    subscribers: HashMap<u64, Subscriber>,
}

pub struct EventHub {
    config: EventHubConfig,
    namespace: u64,
    next_subscriber_id: AtomicU64,
    inner: Mutex<EventHubInner>,
}

impl EventHub {
    pub fn new(config: EventHubConfig) -> Result<Arc<Self>, EventHubError> {
        if config.replay_capacity == 0 || config.replay_capacity > MAX_REPLAY_CAPACITY {
            return Err(EventHubError::InvalidCapacity);
        }
        if config.max_subscribers == 0 {
            return Err(EventHubError::InvalidCapacity);
        }
        static NEXT_NAMESPACE: AtomicU64 = AtomicU64::new(1);
        Ok(Arc::new(Self {
            config,
            namespace: NEXT_NAMESPACE.fetch_add(1, Ordering::Relaxed),
            next_subscriber_id: AtomicU64::new(1),
            inner: Mutex::new(EventHubInner {
                next_sequence: HashMap::new(),
                replay: HashMap::new(),
                subscribers: HashMap::new(),
            }),
        }))
    }

    pub fn subscribe(
        &self,
        device_id: impl Into<String>,
        queue_capacity: usize,
    ) -> Result<EventSubscription, EventHubError> {
        let device_id = device_id.into();
        if device_id.is_empty() || queue_capacity == 0 || queue_capacity > MAX_SUBSCRIBER_QUEUE {
            return Err(EventHubError::InvalidCapacity);
        }
        let mut inner = self.lock_inner();
        if inner.subscribers.len() >= self.config.max_subscribers {
            return Err(EventHubError::SubscriberLimit);
        }
        let (sender, receiver) = mpsc::sync_channel(queue_capacity);
        let id = self.next_subscriber_id.fetch_add(1, Ordering::Relaxed);
        inner.subscribers.insert(
            id,
            Subscriber {
                device_id: device_id.clone(),
                sender,
            },
        );
        Ok(EventSubscription {
            id,
            device_id,
            receiver,
        })
    }

    pub fn subscribe_owned(
        &self,
        principal: &Principal,
        queue_capacity: usize,
    ) -> Result<EventSubscription, EventHubError> {
        if !principal.has_scope(RemoteScope::ReadOwnedTasks) {
            return Err(EventHubError::InvalidDeviceId);
        }
        self.subscribe(principal.device_id(), queue_capacity)
    }

    pub fn unsubscribe(&self, subscription_id: u64) {
        self.lock_inner().subscribers.remove(&subscription_id);
    }

    /// Removes every live subscription for a device. Dropping the senders
    /// makes the corresponding websocket sessions observe disconnection on
    /// their next bounded poll, so revocation/reset cannot leave an
    /// authenticated stream alive until the client happens to close it.
    pub fn unsubscribe_device(&self, device_id: &str) {
        self.lock_inner()
            .subscribers
            .retain(|_, subscriber| subscriber.device_id != device_id);
    }

    pub fn publish(
        &self,
        device_id: &str,
        emitted_at: impl Into<String>,
        payload: EventPayload,
    ) -> PublishedEvent {
        let mut inner = self.lock_inner();
        let sequence = inner
            .next_sequence
            .entry(device_id.to_owned())
            .and_modify(|value| *value += 1)
            .or_insert(1);
        let base = RemoteEventBase {
            event_id: format!("evt-{}-{}", self.namespace, sequence),
            emitted_at: emitted_at.into(),
            sequence: *sequence,
            device_id: device_id.to_owned(),
        };
        let event = event_from_payload(base, payload);
        let history = inner.replay.entry(device_id.to_owned()).or_default();
        history.push_back(event.clone());
        while history.len() > self.config.replay_capacity {
            history.pop_front();
        }

        let mut evicted = Vec::new();
        for (id, subscriber) in &inner.subscribers {
            if subscriber.device_id != device_id {
                continue;
            }
            match subscriber.sender.try_send(event.clone()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    evicted.push(*id)
                }
            }
        }
        for id in &evicted {
            inner.subscribers.remove(id);
        }
        PublishedEvent {
            event,
            evicted_slow_consumers: evicted.len(),
        }
    }

    pub fn replay(&self, device_id: &str, after: Option<u64>, emitted_at: &str) -> ReplayResult {
        let inner = self.lock_inner();
        let (oldest, latest) = inner
            .replay
            .get(device_id)
            .map(|history| {
                (
                    history.front().map(event_sequence),
                    history.back().map(event_sequence).unwrap_or(0),
                )
            })
            .unwrap_or((None, 0));
        let outside_window = after.map_or(false, |cursor| {
            oldest.map_or(false, |first| cursor.saturating_add(1) < first)
        });
        if outside_window {
            // Snapshot-required is a replay control response, not an
            // authoritative domain event. It must not consume sequence space
            // or mutate the retained history; the same stale cursor therefore
            // receives the same stable control event on retry.
            let sequence = latest;
            let event = event_from_payload(
                RemoteEventBase {
                    event_id: format!("snapshot-{}-{}", self.namespace, sequence),
                    emitted_at: emitted_at.to_owned(),
                    sequence,
                    device_id: device_id.to_owned(),
                },
                EventPayload::SnapshotRequired { project_id: None },
            );
            return ReplayResult {
                events: vec![event],
                snapshot_required: true,
            };
        }
        let events = inner
            .replay
            .get(device_id)
            .into_iter()
            .flat_map(|history| history.iter())
            .filter(|event| after.map_or(true, |cursor| event_sequence(event) > cursor))
            .cloned()
            .collect();
        ReplayResult {
            events,
            snapshot_required: false,
        }
    }

    pub fn replay_owned(
        &self,
        principal: &Principal,
        after: Option<u64>,
        emitted_at: &str,
    ) -> Result<ReplayResult, EventHubError> {
        if !principal.has_scope(RemoteScope::ReadOwnedTasks) {
            return Err(EventHubError::InvalidDeviceId);
        }
        Ok(self.replay(principal.device_id(), after, emitted_at))
    }

    pub fn retained_len(&self, device_id: &str) -> usize {
        self.lock_inner()
            .replay
            .get(device_id)
            .map_or(0, VecDeque::len)
    }

    /// Restores the per-device cursor after a gateway restart.  This does
    /// not synthesize an event or expose any storage detail; it only prevents
    /// newly published live events from reusing a persisted sequence.
    pub fn seed_sequence(&self, device_id: &str, sequence: u64) {
        let mut inner = self.lock_inner();
        let cursor = inner.next_sequence.entry(device_id.to_owned()).or_insert(0);
        *cursor = (*cursor).max(sequence);
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, EventHubInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn event_sequence(event: &RemoteEvent) -> u64 {
    match event {
        RemoteEvent::TaskCreated { base, .. }
        | RemoteEvent::TaskStateChanged { base, .. }
        | RemoteEvent::TaskOutputAppended { base, .. }
        | RemoteEvent::TaskCompleted { base, .. }
        | RemoteEvent::TaskChanges { base, .. }
        | RemoteEvent::InteractionRequested { base, .. }
        | RemoteEvent::InteractionResolved { base, .. }
        | RemoteEvent::InteractionExpired { base, .. }
        | RemoteEvent::SnapshotRequired { base, .. }
        | RemoteEvent::EventBackpressure { base, .. } => base.sequence,
    }
}

fn event_from_payload(base: RemoteEventBase, payload: EventPayload) -> RemoteEvent {
    match payload {
        EventPayload::TaskCreated(task) => RemoteEvent::TaskCreated { base, task },
        EventPayload::TaskStateChanged {
            task_id,
            from,
            to,
            error,
        } => RemoteEvent::TaskStateChanged {
            base,
            task_id,
            from,
            to,
            error,
        },
        EventPayload::TaskOutputAppended {
            task_id,
            fragment,
            stream,
        } => RemoteEvent::TaskOutputAppended {
            base,
            task_id,
            fragment,
            stream,
        },
        EventPayload::TaskCompleted {
            task_id,
            state,
            error,
        } => RemoteEvent::TaskCompleted {
            base,
            task_id,
            state,
            error,
        },
        EventPayload::TaskChanges { task_id, revision } => RemoteEvent::TaskChanges {
            base,
            task_id,
            revision,
        },
        EventPayload::InteractionRequested {
            interaction_id,
            task_id,
            interaction_kind,
            prompt,
            expires_at,
        } => RemoteEvent::InteractionRequested {
            base,
            interaction_id,
            task_id,
            interaction_kind,
            prompt,
            expires_at,
        },
        EventPayload::InteractionResolved {
            interaction_id,
            task_id,
            response,
        } => RemoteEvent::InteractionResolved {
            base,
            interaction_id,
            task_id,
            response,
        },
        EventPayload::InteractionExpired {
            interaction_id,
            task_id,
        } => RemoteEvent::InteractionExpired {
            base,
            interaction_id,
            task_id,
        },
        EventPayload::SnapshotRequired { project_id } => {
            RemoteEvent::SnapshotRequired { base, project_id }
        }
        EventPayload::EventBackpressure { task_id, reason } => RemoteEvent::EventBackpressure {
            base,
            task_id,
            reason,
        },
    }
}
