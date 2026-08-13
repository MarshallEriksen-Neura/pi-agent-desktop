//! G004 durable turn lifecycle storage gates.
//!
//! Covers the storage half of the conversation runtime contract: state
//! machine enforcement, atomic terminal commits, restart recovery without
//! replay, revocation, global dispatch ordering, and private session
//! bindings. The ConversationRuntimeManager builds on these operations.

use pi_remote_control::conversation_protocol::{
    RemoteConversationError, RemoteConversationErrorCode, RemoteConversationStatus,
    RemoteMessageStatus, RemoteTurnDeliveryState, RemoteTurnState, RemoteTurnTerminalState,
};
use pi_remote_control::storage::{
    ConversationAcceptance, ConversationAppendAcceptance, ConversationSessionRecord, RemoteStorage,
    StorageError, TurnCompletionInput, TurnExecutionInput,
};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

fn db_path(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("ragcode-pi-g004-{name}-{}.db", std::process::id()));
    cleanup(&path);
    path
}

fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

fn create_acceptance(
    conversation_id: &str,
    request_id: &str,
    created_at_ms: u64,
) -> ConversationAcceptance {
    ConversationAcceptance {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: format!("turn-{request_id}"),
        request_id: request_id.into(),
        project_id: "project-01".into(),
        title: None,
        user_message_id: format!("msg-{request_id}"),
        delivery_id: format!("delivery-{request_id}"),
        prompt: format!("prompt {request_id}"),
        context_json: br#"[]"#.to_vec(),
        created_at_ms,
        created_at: "2026-08-12T00:00:01.000Z".into(),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: created_at_ms + 60_000,
        event_id: format!("event-{request_id}"),
    }
}

fn append_acceptance(
    conversation_id: &str,
    request_id: &str,
    created_at_ms: u64,
) -> ConversationAppendAcceptance {
    ConversationAppendAcceptance {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: format!("turn-{request_id}"),
        request_id: request_id.into(),
        user_message_id: format!("msg-{request_id}"),
        delivery_id: format!("delivery-{request_id}"),
        prompt: format!("prompt {request_id}"),
        context_json: br#"[]"#.to_vec(),
        created_at_ms,
        created_at: "2026-08-12T00:00:02.000Z".into(),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: created_at_ms + 60_000,
        event_id: format!("event-{request_id}"),
    }
}

fn execution_input(
    conversation_id: &str,
    turn_id: &str,
    at_ms: u64,
    event_id: &str,
) -> TurnExecutionInput {
    TurnExecutionInput {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: turn_id.into(),
        at_ms,
        at: "2026-08-12T00:00:03.000Z".into(),
        event_id: event_id.into(),
    }
}

fn completion_input(
    conversation_id: &str,
    turn_id: &str,
    terminal: RemoteTurnTerminalState,
    assistant_message_id: Option<&str>,
    assistant_text: Option<&str>,
    error: Option<RemoteConversationError>,
    at_ms: u64,
) -> TurnCompletionInput {
    TurnCompletionInput {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: turn_id.into(),
        terminal,
        error,
        assistant_message_id: assistant_message_id.map(str::to_owned),
        assistant_text: assistant_text.map(str::to_owned),
        mark_delivery_failed: false,
        at_ms,
        at: "2026-08-12T00:00:09.000Z".into(),
        state_changed_event_id: format!("evt-state-{turn_id}"),
        completed_event_id: format!("evt-completed-{turn_id}"),
        message_completed_event_id: format!("evt-message-{turn_id}"),
        status_changed_event_id: format!("evt-status-{turn_id}"),
    }
}

fn event_kind_count(path: &Path, kind: &str) -> i64 {
    let connection = Connection::open(path).unwrap();
    connection
        .query_row(
            "SELECT COUNT(*) FROM events
             WHERE json_extract(CAST(event_json AS TEXT), '$.kind') = ?1",
            params![kind],
            |row| row.get(0),
        )
        .unwrap()
}

fn turn_state(path: &Path, turn_id: &str) -> String {
    let connection = Connection::open(path).unwrap();
    connection
        .query_row(
            "SELECT state FROM turns WHERE turn_id=?1",
            params![turn_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn turn_lifecycle_commits_final_message_and_terminal_state_atomically() {
    let path = db_path("lifecycle");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", 1_000))
        .unwrap();

    let started = storage
        .mark_turn_started(&execution_input(
            "conv-01",
            "turn-req-01",
            2_000,
            "evt-start-1",
        ))
        .unwrap();
    assert_eq!(started.state, RemoteTurnState::Starting);
    assert_eq!(
        started
            .delivery
            .as_ref()
            .map(|delivery| delivery.status.clone()),
        Some(RemoteTurnDeliveryState::Delivered)
    );

    let running = storage
        .mark_turn_running(&execution_input(
            "conv-01",
            "turn-req-01",
            3_000,
            "evt-run-1",
        ))
        .unwrap();
    assert_eq!(running.state, RemoteTurnState::Running);
    let snapshot = storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::Running);

    let completed = storage
        .complete_turn(&completion_input(
            "conv-01",
            "turn-req-01",
            RemoteTurnTerminalState::Succeeded,
            Some("msg-assistant-01"),
            Some("final answer"),
            None,
            9_000,
        ))
        .unwrap();
    assert_eq!(completed.state, RemoteTurnState::Succeeded);

    // Success is never exposed without the durable final message.
    let page = storage
        .load_conversation_messages("mobile-01", "conv-01", None, 100)
        .unwrap()
        .unwrap();
    assert_eq!(page.messages.len(), 2);
    let assistant = &page.messages[1];
    assert_eq!(assistant.message_id, "msg-assistant-01");
    assert_eq!(assistant.status, RemoteMessageStatus::Completed);
    assert_eq!(assistant.text, "final answer");

    let snapshot = storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::Idle);
    assert_eq!(snapshot.turn_count, 1);
    assert_eq!(snapshot.message_count, 2);

    // Semantic events share the existing outbox with v2 kinds. The first
    // turn rides inside the conversation.created payload; turn.created is
    // only emitted for appended follow-ups.
    assert_eq!(event_kind_count(&path, "conversation.created"), 1);
    assert_eq!(event_kind_count(&path, "turn.created"), 0);
    assert_eq!(event_kind_count(&path, "turn.state_changed"), 3);
    assert_eq!(event_kind_count(&path, "turn.completed"), 1);
    assert_eq!(event_kind_count(&path, "message.completed"), 1);
    assert!(event_kind_count(&path, "conversation.status_changed") >= 2);
    // v1 replay stays clean: no conversation event leaks into load_events.
    assert!(storage.load_events("mobile-01", None).unwrap().is_empty());

    cleanup(&path);
}

#[test]
fn turn_pauses_for_interaction_and_resumes() {
    let path = db_path("interaction");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-02", "req-01", 1_000))
        .unwrap();
    storage
        .mark_turn_started(&execution_input(
            "conv-02",
            "turn-req-01",
            2_000,
            "evt-start-1",
        ))
        .unwrap();
    storage
        .mark_turn_running(&execution_input(
            "conv-02",
            "turn-req-01",
            3_000,
            "evt-run-1",
        ))
        .unwrap();

    let awaiting = storage
        .mark_turn_awaiting_input(&execution_input(
            "conv-02",
            "turn-req-01",
            4_000,
            "evt-await-1",
        ))
        .unwrap();
    assert_eq!(awaiting.state, RemoteTurnState::AwaitingInput);
    let snapshot = storage
        .load_conversation("mobile-01", "conv-02")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::AwaitingInput);

    let resumed = storage
        .mark_turn_running(&execution_input(
            "conv-02",
            "turn-req-01",
            5_000,
            "evt-run-2",
        ))
        .unwrap();
    assert_eq!(resumed.state, RemoteTurnState::Running);

    storage
        .complete_turn(&completion_input(
            "conv-02",
            "turn-req-01",
            RemoteTurnTerminalState::Succeeded,
            Some("msg-assistant-01"),
            Some("done"),
            None,
            9_000,
        ))
        .unwrap();
    assert_eq!(turn_state(&path, "turn-req-01"), "succeeded");

    cleanup(&path);
}

#[test]
fn invalid_transitions_are_rejected_without_mutation() {
    let path = db_path("invalid");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-03", "req-01", 1_000))
        .unwrap();
    let events_before = event_kind_count(&path, "turn.state_changed");

    // queued -> running skips starting and must be refused.
    let err = storage
        .mark_turn_running(&execution_input(
            "conv-03",
            "turn-req-01",
            2_000,
            "evt-bad-1",
        ))
        .unwrap_err();
    assert_eq!(err, StorageError::InvalidTransition);

    // queued -> succeeded is equally illegal.
    let err = storage
        .complete_turn(&completion_input(
            "conv-03",
            "turn-req-01",
            RemoteTurnTerminalState::Succeeded,
            Some("msg-assistant-01"),
            Some("nope"),
            None,
            3_000,
        ))
        .unwrap_err();
    assert_eq!(err, StorageError::InvalidTransition);

    assert_eq!(turn_state(&path, "turn-req-01"), "queued");
    assert_eq!(event_kind_count(&path, "turn.state_changed"), events_before);

    cleanup(&path);
}

#[test]
fn success_requires_durable_assistant_message() {
    let path = db_path("success-requires-message");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-04", "req-01", 1_000))
        .unwrap();
    storage
        .mark_turn_started(&execution_input(
            "conv-04",
            "turn-req-01",
            2_000,
            "evt-start-1",
        ))
        .unwrap();
    storage
        .mark_turn_running(&execution_input(
            "conv-04",
            "turn-req-01",
            3_000,
            "evt-run-1",
        ))
        .unwrap();

    // A succeeded turn without a final message is a caller bug — refuse it.
    let err = storage
        .complete_turn(&completion_input(
            "conv-04",
            "turn-req-01",
            RemoteTurnTerminalState::Succeeded,
            None,
            None,
            None,
            9_000,
        ))
        .unwrap_err();
    assert_eq!(err, StorageError::InvalidKey);

    // Empty assistant text is equally unacceptable.
    let err = storage
        .complete_turn(&completion_input(
            "conv-04",
            "turn-req-01",
            RemoteTurnTerminalState::Succeeded,
            Some("msg-assistant-01"),
            Some(""),
            None,
            9_000,
        ))
        .unwrap_err();
    assert_eq!(err, StorageError::InvalidKey);

    assert_eq!(turn_state(&path, "turn-req-01"), "running");

    // A failed turn may omit the assistant message entirely.
    storage
        .complete_turn(&completion_input(
            "conv-04",
            "turn-req-01",
            RemoteTurnTerminalState::Failed,
            None,
            None,
            Some(RemoteConversationError {
                code: RemoteConversationErrorCode::ProcessFailed,
                message: "pi exited early".into(),
                retryable: false,
            }),
            9_500,
        ))
        .unwrap();
    assert_eq!(turn_state(&path, "turn-req-01"), "failed");

    cleanup(&path);
}

#[test]
fn restart_recovery_marks_in_flight_turns_failed_once_and_keeps_queued_dispatchable() {
    let path = db_path("recovery");
    let storage = RemoteStorage::open(&path).unwrap();
    // conv-01 has an in-flight turn when the desktop dies.
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", 1_000))
        .unwrap();
    storage
        .mark_turn_started(&execution_input(
            "conv-01",
            "turn-req-01",
            2_000,
            "evt-start-1",
        ))
        .unwrap();
    storage
        .mark_turn_running(&execution_input(
            "conv-01",
            "turn-req-01",
            3_000,
            "evt-run-1",
        ))
        .unwrap();
    // conv-02 only has durable queued intent — it must survive untouched.
    storage
        .create_conversation_turn(&create_acceptance("conv-02", "req-02", 1_500))
        .unwrap();

    let recovered = storage
        .recover_non_terminal_turns(50_000, "2026-08-12T00:00:50.000Z")
        .unwrap();
    assert_eq!(
        recovered,
        vec![("conv-01".to_owned(), "turn-req-01".to_owned())]
    );

    // The interrupted turn is failed exactly once with a redacted host error.
    let snapshot = storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::Interrupted);
    let latest = snapshot.latest_turn.unwrap();
    assert_eq!(latest.state, RemoteTurnState::Failed);
    let error = latest.error.unwrap();
    assert_eq!(error.code, RemoteConversationErrorCode::HostInterrupted);
    assert!(!error.retryable);

    // Queued intent stays dispatchable — durable-before-delivery survives restarts.
    let dispatchable = storage.next_dispatchable_turn().unwrap().unwrap();
    assert_eq!(dispatchable.conversation_id, "conv-02");
    assert_eq!(dispatchable.turn_id, "turn-req-02");

    // Recovery is idempotent: a second startup pass mutates nothing.
    let events_before = event_kind_count(&path, "turn.completed");
    let again = storage
        .recover_non_terminal_turns(60_000, "2026-08-12T00:01:00.000Z")
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(event_kind_count(&path, "turn.completed"), events_before);

    cleanup(&path);
}

#[test]
fn revocation_fails_only_queued_turns_and_preserves_history() {
    let path = db_path("revocation");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-05", "req-01", 1_000))
        .unwrap();
    storage
        .append_conversation_turn(&append_acceptance("conv-05", "req-02", 2_000))
        .unwrap();
    storage
        .append_conversation_turn(&append_acceptance("conv-05", "req-03", 3_000))
        .unwrap();
    storage
        .mark_turn_started(&execution_input(
            "conv-05",
            "turn-req-01",
            4_000,
            "evt-start-1",
        ))
        .unwrap();

    let failed = storage
        .fail_queued_turns(
            "mobile-01",
            "conv-05",
            &RemoteConversationError {
                code: RemoteConversationErrorCode::ProjectRevoked,
                message: "project access was revoked".into(),
                retryable: false,
            },
            5_000,
            "2026-08-12T00:00:05.000Z",
        )
        .unwrap();
    assert_eq!(failed, 2);

    // The in-flight turn is untouched — cancellation is the runtime's job.
    assert_eq!(turn_state(&path, "turn-req-01"), "starting");
    assert_eq!(turn_state(&path, "turn-req-02"), "failed");
    assert_eq!(turn_state(&path, "turn-req-03"), "failed");

    // History stays readable; the revocation is visible through events.
    let snapshot = storage
        .load_conversation("mobile-01", "conv-05")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.turn_count, 3);
    assert_eq!(snapshot.message_count, 3);
    assert_eq!(event_kind_count(&path, "turn.created"), 2);
    assert_eq!(event_kind_count(&path, "turn.completed"), 2);

    // Queued turns no longer dispatch after revocation.
    assert!(storage.next_dispatchable_turn().unwrap().is_none());

    cleanup(&path);
}

#[test]
fn dispatch_returns_oldest_queued_and_counts_global_active_turns() {
    let path = db_path("dispatch");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-a", "req-a", 1_000))
        .unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-b", "req-b", 2_000))
        .unwrap();

    assert_eq!(storage.count_active_turns().unwrap(), 0);

    // FIFO across conversations by acceptance time.
    let first = storage.next_dispatchable_turn().unwrap().unwrap();
    assert_eq!(first.conversation_id, "conv-a");
    assert_eq!(first.project_id, "project-01");
    assert_eq!(first.prompt, "prompt req-a");

    storage
        .mark_turn_started(&execution_input(
            "conv-a",
            "turn-req-a",
            3_000,
            "evt-start-a",
        ))
        .unwrap();
    assert_eq!(storage.count_active_turns().unwrap(), 1);

    let second = storage.next_dispatchable_turn().unwrap().unwrap();
    assert_eq!(second.conversation_id, "conv-b");
    storage
        .mark_turn_started(&execution_input(
            "conv-b",
            "turn-req-b",
            4_000,
            "evt-start-b",
        ))
        .unwrap();
    assert_eq!(storage.count_active_turns().unwrap(), 2);

    // Everything is now in flight: nothing left to dispatch. The manager
    // compares count_active_turns against REMOTE_CONVERSATION_GLOBAL_ACTIVE_TURNS
    // before starting another turn.
    assert!(storage.next_dispatchable_turn().unwrap().is_none());

    cleanup(&path);
}

#[test]
fn session_binding_roundtrip_owner_isolation_and_delete() {
    let path = db_path("session-binding");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-06", "req-01", 1_000))
        .unwrap();

    let record = ConversationSessionRecord {
        owner_device_id: "mobile-01".into(),
        conversation_id: "conv-06".into(),
        session_id: "sess-06".into(),
        relative_ref: "mobile-01/project-01/conv-06/session.jsonl".into(),
        pi_version: "0.84.1".into(),
        format_fingerprint: "pi-session-jsonl-v3:type,id,cwd".into(),
        state: "bound".into(),
        updated_at_ms: 2_000,
    };
    storage.store_conversation_session(&record).unwrap();
    assert_eq!(
        storage
            .load_conversation_session("mobile-01", "conv-06")
            .unwrap()
            .unwrap(),
        record
    );

    // Upsert replaces the binding without duplicating rows.
    let mut updated = record.clone();
    updated.state = "released".into();
    updated.updated_at_ms = 3_000;
    storage.store_conversation_session(&updated).unwrap();
    assert_eq!(
        storage
            .load_conversation_session("mobile-01", "conv-06")
            .unwrap()
            .unwrap()
            .state,
        "released"
    );

    // Another device sees nothing — same as not found.
    assert!(storage
        .load_conversation_session("mobile-02", "conv-06")
        .unwrap()
        .is_none());
    let mut foreign = record.clone();
    foreign.owner_device_id = "mobile-02".into();
    assert_eq!(
        storage.store_conversation_session(&foreign).unwrap_err(),
        StorageError::InvalidKey
    );
    assert_eq!(
        storage
            .delete_conversation_session("mobile-02", "conv-06")
            .unwrap_err(),
        StorageError::InvalidKey
    );

    storage
        .delete_conversation_session("mobile-01", "conv-06")
        .unwrap();
    assert!(storage
        .load_conversation_session("mobile-01", "conv-06")
        .unwrap()
        .is_none());

    cleanup(&path);
}
