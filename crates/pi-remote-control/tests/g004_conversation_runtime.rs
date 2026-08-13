//! G004 ConversationRuntimeManager fixture-driven gates.
//!
//! Exercises dispatch, warm reuse, cold-resume context continuity,
//! fail-closed project/session handling, and cancellation through the fake
//! Pi session binary. The settle-delay environment variable is process
//! global, so every test here serializes behind `lock_fixture`.

use pi_remote_control::conversation_protocol::{
    RemoteConversationErrorCode, RemoteConversationStatus, RemoteMessageStatus, RemoteTurnState,
    RemoteTurnTerminalState,
};
use pi_remote_control::conversation_runtime::{
    ConversationRuntimeConfig, ConversationRuntimeManager, DispatchOutcome,
};
use pi_remote_control::pi_session::{PiSessionAdapter, PiSessionConfig, PiSessionContext};
use pi_remote_control::project_catalog::{ProjectCatalog, ProjectCatalogConfig};
use pi_remote_control::storage::{
    ConversationAcceptance, ConversationAppendAcceptance, ConversationSessionRecord, RemoteStorage,
};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

static FIXTURE_LOCK: Mutex<()> = Mutex::new(());

struct FixtureGuard {
    _lock: MutexGuard<'static, ()>,
}

impl Drop for FixtureGuard {
    fn drop(&mut self) {
        std::env::remove_var("FAKE_PI_SETTLE_DELAY_MS");
    }
}

fn lock_fixture() -> FixtureGuard {
    FixtureGuard {
        _lock: FIXTURE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()),
    }
}

fn fixture_dir(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("ragcode-pi-g004-rt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn fake_pi() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake_pi_session_fixture"))
}

struct RuntimeRig {
    root: PathBuf,
    session_root: PathBuf,
    project_id: String,
    storage: Arc<RemoteStorage>,
    manager: Arc<ConversationRuntimeManager>,
}

fn rig(name: &str, config: ConversationRuntimeConfig) -> RuntimeRig {
    let root = fixture_dir(name);
    let project_root = root.join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    let storage = Arc::new(RemoteStorage::open(root.join("remote.db")).unwrap());
    let projects = Arc::new(ProjectCatalog::new(ProjectCatalogConfig::default()));
    let summary = projects
        .allow_project(&project_root, "g004 project", None)
        .unwrap();
    let session_config = PiSessionConfig {
        stop_timeout: Duration::from_secs(2),
        rpc_timeout: Duration::from_secs(2),
        turn_timeout: Duration::from_secs(20),
        ..PiSessionConfig::new(fake_pi().into_os_string(), root.join("private-sessions"))
    };
    let probe_context = PiSessionContext {
        owner_device_id: "mobile-01".into(),
        conversation_id: "probe".into(),
        project_id: summary.project_id.clone(),
        project_root: project_root.clone(),
    };
    let probe = PiSessionAdapter::probe(session_config.clone(), probe_context).unwrap();
    let adapter = Arc::new(PiSessionAdapter::new(session_config, probe).unwrap());
    let manager =
        ConversationRuntimeManager::new(storage.clone(), projects.clone(), adapter, config);
    RuntimeRig {
        session_root: root.join("private-sessions"),
        root,
        project_id: summary.project_id,
        storage,
        manager,
    }
}

fn teardown(rig: RuntimeRig) {
    let root = rig.root.clone();
    drop(rig);
    let _ = std::fs::remove_dir_all(root);
}

fn create_acceptance(
    project_id: &str,
    conversation_id: &str,
    request_id: &str,
    created_at_ms: u64,
) -> ConversationAcceptance {
    ConversationAcceptance {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: format!("turn-{request_id}"),
        request_id: request_id.into(),
        project_id: project_id.into(),
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

fn session_file_of(rig: &RuntimeRig, conversation_id: &str) -> PathBuf {
    let record = rig
        .storage
        .load_conversation_session("mobile-01", conversation_id)
        .unwrap()
        .unwrap();
    rig.session_root.join(
        record
            .relative_ref
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    )
}

fn turn_state_of(rig: &RuntimeRig, turn_id: &str) -> String {
    let connection = Connection::open(rig.root.join("remote.db")).unwrap();
    connection
        .query_row(
            "SELECT state FROM turns WHERE turn_id=?1",
            params![turn_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn dispatch_executes_turn_and_commits_durable_assistant_message_with_binding() {
    let _guard = lock_fixture();
    let rig = rig("dispatch-basic", ConversationRuntimeConfig::default());

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();

    let outcome = rig.manager.dispatch_next();
    assert_eq!(
        outcome,
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );

    // Success is exposed only with the durable final assistant message.
    let page = rig
        .storage
        .load_conversation_messages("mobile-01", "conv-01", None, 100)
        .unwrap()
        .unwrap();
    assert_eq!(page.messages.len(), 2);
    let assistant = &page.messages[1];
    assert_eq!(assistant.status, RemoteMessageStatus::Completed);
    assert_eq!(assistant.text, "settled prompt 1");

    let snapshot = rig
        .storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::Idle);

    // The private binding is persisted and warm for the idle window.
    let record = rig
        .storage
        .load_conversation_session("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert!(!record.session_id.is_empty());
    assert!(!record.relative_ref.is_empty());
    assert_eq!(rig.manager.warm_session_count(), 1);

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn second_turn_reuses_warm_session_and_context_continues() {
    let _guard = lock_fixture();
    let rig = rig("warm-reuse", ConversationRuntimeConfig::default());

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );
    let first_ref = rig
        .storage
        .load_conversation_session("mobile-01", "conv-01")
        .unwrap()
        .unwrap()
        .relative_ref;

    rig.storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-02".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );

    // Same private session file carries both prompts (context continuity).
    let session_file = session_file_of(&rig, "conv-01");
    let content = std::fs::read_to_string(&session_file).unwrap();
    assert!(content.contains("prompt req-01"));
    assert!(content.contains("prompt req-02"));
    assert_eq!(
        rig.storage
            .load_conversation_session("mobile-01", "conv-01")
            .unwrap()
            .unwrap()
            .relative_ref,
        first_ref
    );

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn warm_eviction_forces_cold_resume_that_keeps_context() {
    let _guard = lock_fixture();
    let rig = rig(
        "eviction",
        ConversationRuntimeConfig {
            warm_idle_window: Duration::from_millis(0),
            ..ConversationRuntimeConfig::default()
        },
    );

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );
    let first_ref = rig
        .storage
        .load_conversation_session("mobile-01", "conv-01")
        .unwrap()
        .unwrap()
        .relative_ref;

    rig.storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();
    // Zero idle window: the next dispatch evicts the warm child and must
    // cold-resume through the stored binding.
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-02".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );

    let session_file = session_file_of(&rig, "conv-01");
    let content = std::fs::read_to_string(&session_file).unwrap();
    assert!(content.contains("prompt req-01"));
    assert!(content.contains("prompt req-02"));
    assert_eq!(
        rig.storage
            .load_conversation_session("mobile-01", "conv-01")
            .unwrap()
            .unwrap()
            .relative_ref,
        first_ref
    );

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn missing_project_fails_closed_before_delivery() {
    let _guard = lock_fixture();
    let rig = rig("ghost-project", ConversationRuntimeConfig::default());

    // Storage accepts any project id; the catalog gate trips at dispatch.
    rig.storage
        .create_conversation_turn(&create_acceptance(
            "project-ghost",
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();

    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::ProjectRevoked {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
        }
    );

    let snapshot = rig
        .storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    let latest = snapshot.latest_turn.unwrap();
    assert_eq!(latest.state, RemoteTurnState::Failed);
    assert_eq!(
        latest.error.unwrap().code,
        RemoteConversationErrorCode::ProjectRevoked
    );
    assert_eq!(
        latest.delivery.unwrap().status,
        pi_remote_control::conversation_protocol::RemoteTurnDeliveryState::Failed
    );

    // Nothing dispatches afterwards and no session was created.
    assert!(rig.storage.next_dispatchable_turn().unwrap().is_none());
    assert_eq!(rig.manager.warm_session_count(), 0);
    assert!(rig
        .storage
        .load_conversation_session("mobile-01", "conv-01")
        .unwrap()
        .is_none());

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn accepted_follow_up_survives_session_failure_without_delivery_or_replay() {
    let _guard = lock_fixture();
    let rig = rig(
        "durable-before-session-failure",
        ConversationRuntimeConfig {
            warm_idle_window: Duration::from_millis(0),
            ..ConversationRuntimeConfig::default()
        },
    );

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();
    assert!(matches!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            terminal: RemoteTurnTerminalState::Succeeded,
            ..
        }
    ));

    rig.storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();

    // Corrupt only the private binding after acceptance. The queued follow-up
    // and its user message must remain durable, while Pi receives nothing.
    let mut binding = rig
        .storage
        .load_conversation_session("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    binding.relative_ref = "../outside-session.jsonl".into();
    rig.storage
        .store_conversation_session(&ConversationSessionRecord {
            relative_ref: binding.relative_ref,
            ..binding
        })
        .unwrap();

    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::SessionUnavailable {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-02".into(),
        }
    );

    let snapshot = rig
        .storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    let latest = snapshot.latest_turn.unwrap();
    assert_eq!(latest.state, RemoteTurnState::Failed);
    assert_eq!(
        latest.error.unwrap().code,
        RemoteConversationErrorCode::SessionResumeUnavailable
    );
    assert_eq!(
        latest.delivery.unwrap().status,
        pi_remote_control::conversation_protocol::RemoteTurnDeliveryState::Failed
    );

    let page = rig
        .storage
        .load_conversation_messages("mobile-01", "conv-01", None, 100)
        .unwrap()
        .unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[2].message_id, "msg-req-02");
    assert_eq!(page.messages[2].status, RemoteMessageStatus::Accepted);
    assert_eq!(page.messages[2].text, "prompt req-02");
    assert!(rig.storage.next_dispatchable_turn().unwrap().is_none());

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn cancel_queued_turn_stops_only_that_turn_and_cross_owner_is_refused() {
    let _guard = lock_fixture();
    let rig = rig("cancel-queued", ConversationRuntimeConfig::default());

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();
    rig.storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();

    // Cross-owner cancellation is indistinguishable from a bad key.
    assert!(!rig
        .manager
        .cancel_turn("mobile-02", "conv-01", "turn-req-02"));

    assert!(rig
        .manager
        .cancel_turn("mobile-01", "conv-01", "turn-req-02"));
    assert_eq!(turn_state_of(&rig, "turn-req-02"), "cancelled");

    // The remaining queued turn still dispatches.
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );

    rig.manager.stop();
    teardown(rig);
}

#[test]
fn mid_run_cancel_stops_process_tree_and_marks_cancelled_once() {
    let _guard = lock_fixture();
    std::env::set_var("FAKE_PI_SETTLE_DELAY_MS", "2000");
    let rig = rig("mid-run-cancel", ConversationRuntimeConfig::default());

    rig.storage
        .create_conversation_turn(&create_acceptance(
            &rig.project_id,
            "conv-01",
            "req-01",
            1_000,
        ))
        .unwrap();
    // Turn 1 completes and persists the private binding first.
    assert_eq!(
        rig.manager.dispatch_next(),
        DispatchOutcome::Completed {
            conversation_id: "conv-01".into(),
            turn_id: "turn-req-01".into(),
            terminal: RemoteTurnTerminalState::Succeeded,
        }
    );
    rig.storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();

    rig.manager.start();
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        let active = rig.manager.active_execution();
        if active
            .map(|(_, conversation, turn)| conversation == "conv-01" && turn == "turn-req-02")
            .unwrap_or(false)
        {
            break;
        }
        assert!(Instant::now() < deadline, "turn never started executing");
        std::thread::sleep(Duration::from_millis(20));
    }

    assert!(rig
        .manager
        .cancel_turn("mobile-01", "conv-01", "turn-req-02"));
    assert!(rig.manager.wait_for_idle(Duration::from_secs(8)));
    rig.manager.stop();

    // The interrupted turn is cancelled exactly once, never auto-replayed.
    assert_eq!(turn_state_of(&rig, "turn-req-02"), "cancelled");
    assert!(rig.storage.next_dispatchable_turn().unwrap().is_none());
    let snapshot = rig
        .storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, RemoteConversationStatus::Idle);
    assert_eq!(
        snapshot.latest_turn.unwrap().error.unwrap().code,
        RemoteConversationErrorCode::Cancelled
    );

    // Completed history survives: the first turn's message pair is intact and
    // the delivered second prompt is visible in the private session file.
    let page = rig
        .storage
        .load_conversation_messages("mobile-01", "conv-01", None, 100)
        .unwrap()
        .unwrap();
    assert_eq!(page.messages.len(), 3);
    assert_eq!(page.messages[1].text, "settled prompt 1");
    let session_file = session_file_of(&rig, "conv-01");
    let content = std::fs::read_to_string(&session_file).unwrap();
    assert!(content.contains("prompt req-01"));
    assert!(content.contains("prompt req-02"));

    teardown(rig);
}
