use std::sync::Arc;
use std::time::Duration;

use pi_remote_control::event_hub::{EventHub, EventHubConfig, EventPayload};
use pi_remote_control::interaction::{InteractionError, InteractionManager};
use pi_remote_control::principal::{Principal, RemoteScope};
use pi_remote_control::protocol::{
    RemoteInteractionKind, RemoteInteractionRequest, RemoteInteractionResponse,
    RemoteInteractionResponseValue, RemoteTaskCreateRequest, RemoteTaskState, ValidationError,
    MAX_CONTEXT_FILES,
};
use pi_remote_control::task_manager::{ManualClock, TaskManager, TaskManagerError};

fn principal(id: &str) -> Principal {
    Principal::v1(id, 1).expect("valid test principal")
}

fn request(request_id: &str) -> RemoteTaskCreateRequest {
    RemoteTaskCreateRequest {
        request_id: request_id.to_owned(),
        project_id: "project-opaque".to_owned(),
        prompt: "run the bounded task".to_owned(),
        context_files: Vec::new(),
        execution_profile: None,
    }
}

fn hub() -> Arc<EventHub> {
    EventHub::new(EventHubConfig {
        replay_capacity: 32,
        max_subscribers: 8,
    })
    .expect("valid event hub")
}

#[test]
fn task_manager_enforces_queue_idempotency_owner_and_single_terminal_event() {
    let hub = hub();
    let clock = ManualClock::new(0);
    let manager = TaskManager::with_clock(hub.clone(), clock.clone());
    let owner = principal("device-a");
    let other = principal("device-b");

    let first = manager
        .submit(&owner, request("request-0"))
        .expect("first submit");
    let duplicate = manager
        .submit(&owner, request("request-0"))
        .expect("duplicate submit");
    assert!(duplicate.duplicate);
    assert_eq!(duplicate.snapshot.task_id, first.snapshot.task_id);
    let mut conflicting = request("request-0");
    conflicting.prompt = "different request body".to_owned();
    assert_eq!(
        manager.submit(&owner, conflicting),
        Err(TaskManagerError::IdempotencyConflict)
    );

    for index in 1..8 {
        manager
            .submit(&owner, request(&format!("request-{index}")))
            .expect("queue slot");
    }
    assert_eq!(manager.queued_len(), 8);
    assert_eq!(
        manager.submit(&owner, request("request-overflow")),
        Err(TaskManagerError::QueueFull)
    );

    assert_eq!(
        manager.snapshot(&other, &first.snapshot.task_id),
        Err(TaskManagerError::TaskNotFound)
    );
    assert_eq!(
        manager.cancel(&other, &first.snapshot.task_id),
        Err(TaskManagerError::TaskNotFound)
    );

    manager
        .start(&owner, &first.snapshot.task_id)
        .expect("start task");
    manager
        .transition_owned(
            &owner,
            &first.snapshot.task_id,
            RemoteTaskState::Running,
            None,
        )
        .expect("running");
    manager
        .transition_owned(
            &owner,
            &first.snapshot.task_id,
            RemoteTaskState::AwaitingInput,
            None,
        )
        .expect("awaiting input");
    manager
        .transition_owned(
            &owner,
            &first.snapshot.task_id,
            RemoteTaskState::Running,
            None,
        )
        .expect("resume");
    manager
        .transition_owned(
            &owner,
            &first.snapshot.task_id,
            RemoteTaskState::Succeeded,
            None,
        )
        .expect("terminal");
    assert_eq!(manager.active_task_id(), None);
    assert_eq!(
        manager.transition_owned(
            &owner,
            &first.snapshot.task_id,
            RemoteTaskState::Failed,
            None
        ),
        Err(TaskManagerError::AlreadyTerminal)
    );
    assert!(
        manager
            .cancel(&owner, &first.snapshot.task_id)
            .expect("idempotent cancel")
            .duplicate
    );

    let events = hub
        .replay("device-a", None, "1970-01-01T00:00:01.000Z")
        .events;
    let terminal_events = events
        .iter()
        .filter(|event| {
            matches!(
                event,
                pi_remote_control::protocol::RemoteEvent::TaskCompleted { .. }
            )
        })
        .count();
    assert_eq!(terminal_events, 1);
}

#[test]
fn queued_terminal_transition_releases_capacity() {
    let hub = hub();
    let manager = TaskManager::new(hub);
    let owner = principal("device-a");
    let first = manager
        .submit(&owner, request("request-0"))
        .expect("submit");
    manager
        .cancel(&owner, &first.snapshot.task_id)
        .expect("cancel queued task");
    assert_eq!(manager.queued_len(), 0);
}

#[test]
fn interaction_validates_owner_expiry_and_duplicate_response() {
    let hub = hub();
    let clock = ManualClock::new(1_000);
    let manager = InteractionManager::with_clock(hub, clock.clone());
    let owner = principal("device-a");
    let other = principal("device-b");
    let request = RemoteInteractionRequest {
        interaction_id: "interaction-1".to_owned(),
        task_id: "task-1".to_owned(),
        kind: RemoteInteractionKind::Confirm,
        prompt: "allow the operation?".to_owned(),
        options: None,
        created_at: "1970-01-01T00:00:01.000Z".to_owned(),
        expires_at: "1970-01-01T00:00:02.000Z".to_owned(),
    };
    manager
        .create(&owner, request)
        .expect("interaction request");
    let response = RemoteInteractionResponse {
        interaction_id: "interaction-1".to_owned(),
        kind: RemoteInteractionKind::Confirm,
        value: RemoteInteractionResponseValue::Boolean(true),
        submitted_at: "1970-01-01T00:00:01.500Z".to_owned(),
    };
    assert_eq!(
        manager.respond(&other, response.clone()),
        Err(InteractionError::NotFound)
    );
    let resolved = manager.respond(&owner, response.clone()).expect("response");
    assert!(!resolved.duplicate);
    assert!(
        manager
            .respond(&owner, response)
            .expect("duplicate response")
            .duplicate
    );

    let expired = RemoteInteractionRequest {
        interaction_id: "interaction-2".to_owned(),
        task_id: "task-1".to_owned(),
        kind: RemoteInteractionKind::Input,
        prompt: "give a value".to_owned(),
        options: None,
        created_at: "1970-01-01T00:00:01.000Z".to_owned(),
        expires_at: "1970-01-01T00:00:02.000Z".to_owned(),
    };
    manager.create(&owner, expired).expect("second interaction");
    clock.advance(Duration::from_secs(2));
    assert_eq!(manager.expire_due().len(), 1);
    assert_eq!(manager.pending_len(), 0);
}

#[test]
fn replay_is_bounded_and_slow_subscriber_is_evicted_without_blocking_publish() {
    let hub = EventHub::new(EventHubConfig {
        replay_capacity: 2,
        max_subscribers: 2,
    })
    .expect("valid event hub");
    let subscription = hub.subscribe("device-a", 1).expect("subscriber");
    for index in 0..3 {
        hub.publish(
            "device-a",
            format!("1970-01-01T00:00:0{index}.000Z"),
            EventPayload::TaskChanges {
                task_id: "task-1".to_owned(),
                revision: index,
            },
        );
    }
    assert_eq!(hub.retained_len("device-a"), 2);
    assert_eq!(subscription.try_recv().is_ok(), true);
    let replay = hub.replay("device-a", Some(0), "1970-01-01T00:00:03.000Z");
    assert!(replay.snapshot_required);
    assert!(matches!(
        replay.events.first(),
        Some(pi_remote_control::protocol::RemoteEvent::SnapshotRequired { .. })
    ));
    let replay_again = hub.replay("device-a", Some(0), "1970-01-01T00:00:04.000Z");
    let first_snapshot = match replay.events.first() {
        Some(pi_remote_control::protocol::RemoteEvent::SnapshotRequired { base, .. }) => base,
        _ => panic!("expected snapshot control event"),
    };
    let second_snapshot = match replay_again.events.first() {
        Some(pi_remote_control::protocol::RemoteEvent::SnapshotRequired { base, .. }) => base,
        _ => panic!("expected snapshot control event"),
    };
    assert_eq!(first_snapshot.event_id, second_snapshot.event_id);
    assert_eq!(first_snapshot.sequence, second_snapshot.sequence);
    assert_eq!(hub.retained_len("device-a"), 2);
}

#[test]
fn device_unsubscribe_disconnects_all_live_subscriptions() {
    let hub = hub();
    let first = hub.subscribe("mobile-1", 2).expect("first subscription");
    let second = hub.subscribe("mobile-1", 2).expect("second subscription");
    let other = hub.subscribe("mobile-2", 2).expect("other subscription");

    hub.unsubscribe_device("mobile-1");

    assert!(matches!(
        first.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Disconnected)
    ));
    assert!(matches!(
        second.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Disconnected)
    ));
    assert!(matches!(
        other.try_recv(),
        Err(std::sync::mpsc::TryRecvError::Empty)
    ));
}

#[test]
fn all_client_supplied_task_limits_are_explicit() {
    let mut oversized = request("request");
    oversized.prompt = "x".repeat(16 * 1024 + 1);
    assert!(matches!(
        oversized.validate(),
        Err(ValidationError::TooLong { .. })
    ));
    let mut too_many_files = request("request");
    too_many_files.context_files = (0..=MAX_CONTEXT_FILES)
        .map(|index| pi_remote_control::protocol::RemoteTaskContextFile {
            relative_path: format!("file-{index}.txt"),
        })
        .collect();
    assert!(matches!(
        too_many_files.validate(),
        Err(ValidationError::TooMany { .. })
    ));
    let mut invalid_path = request("request");
    invalid_path.context_files = vec![pi_remote_control::protocol::RemoteTaskContextFile {
        relative_path: "../secret.txt".to_owned(),
    }];
    assert!(matches!(
        invalid_path.validate(),
        Err(ValidationError::InvalidValue { .. })
    ));
    assert!(owner_scope_is_narrow());
}

fn owner_scope_is_narrow() -> bool {
    let principal = principal("device-a");
    principal.has_scope(RemoteScope::CreateTasks)
        && principal.has_scope(RemoteScope::CancelOwnedTasks)
        && !principal.owns("device-b")
}
