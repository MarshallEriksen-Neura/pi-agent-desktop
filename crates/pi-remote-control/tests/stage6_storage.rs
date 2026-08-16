use pi_remote_control::protocol::{RemoteEvent, RemoteTaskCreateRequest, RemoteTaskSnapshot};
use pi_remote_control::storage::{
    IdempotencyRecord, RemoteStorage, StorageError, StorageLimits, StoredDevice, StoredEvent,
};
use rusqlite::Connection;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn db_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ragcode-pi-stage6-{name}-{}.db",
        std::process::id()
    ));
    let _ = fs::remove_file(&path);
    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));
    path
}

fn snapshot() -> RemoteTaskSnapshot {
    serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/snapshot-awaiting-input.json"
    ))
    .unwrap()
}

fn event() -> RemoteEvent {
    serde_json::from_str(include_str!("../../../packages/remote-control-contracts/fixtures/v1/events/task-state-awaiting-input.json")).unwrap()
}

fn request() -> RemoteTaskCreateRequest {
    RemoteTaskCreateRequest {
        request_id: "request-01".into(),
        project_id: "project-01".into(),
        prompt: "persist this request".into(),
        context_files: vec![pi_remote_control::protocol::RemoteTaskContextFile {
            relative_path: "src/lib/pi/protocol.ts".into(),
        }],
        execution_profile: None,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn stored_event(id: &str, sequence: u64) -> StoredEvent {
    let mut payload = serde_json::to_value(event()).unwrap();
    payload["eventId"] = serde_json::Value::String(id.into());
    payload["sequence"] = serde_json::Value::Number(sequence.into());
    StoredEvent {
        device_id: "mobile-01".into(),
        sequence,
        event_id: id.into(),
        emitted_at_ms: now_ms(),
        payload: serde_json::from_value(payload).unwrap(),
    }
}

#[test]
fn migration_enables_wal_and_atomic_snapshot_event_idempotency_commit() {
    let path = db_path("atomic");
    let storage = RemoteStorage::open(&path).unwrap();
    let idempotency = IdempotencyRecord {
        device_id: "mobile-01".into(),
        request_id: "request-01".into(),
        task_id: "task-01".into(),
        fingerprint: 7,
        expires_at_ms: now_ms() + 60_000,
    };
    storage
        .commit_task_event(
            &snapshot(),
            &stored_event("event-01", 1),
            Some(&idempotency),
        )
        .unwrap();
    assert_eq!(storage.counts().unwrap(), (1, 1));
    assert_eq!(storage.load_non_terminal_tasks().unwrap().len(), 1);
    let connection = Connection::open(&path).unwrap();
    let mode: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    let _ = fs::remove_file(path);
}

#[test]
fn duplicate_event_rolls_back_snapshot_update_and_conflicting_idempotency() {
    let path = db_path("rollback");
    let storage = RemoteStorage::open(&path).unwrap();
    let original_idempotency = IdempotencyRecord {
        device_id: "mobile-01".into(),
        request_id: "request-01".into(),
        task_id: "task-01".into(),
        fingerprint: 7,
        expires_at_ms: now_ms() + 60_000,
    };
    storage
        .commit_task_event(
            &snapshot(),
            &stored_event("event-01", 1),
            Some(&original_idempotency),
        )
        .unwrap();
    let mut changed = snapshot();
    changed.state = pi_remote_control::protocol::RemoteTaskState::Running;
    let result = storage.commit_task_event(&changed, &stored_event("event-01", 1), None);
    assert_eq!(result, Err(StorageError::Database));
    assert_eq!(
        storage.load_non_terminal_tasks().unwrap()[0].state,
        pi_remote_control::protocol::RemoteTaskState::AwaitingInput
    );
    let conflict = IdempotencyRecord {
        device_id: "mobile-01".into(),
        request_id: "request-01".into(),
        task_id: "task-01".into(),
        fingerprint: 9,
        expires_at_ms: now_ms() + 60_000,
    };
    let result =
        storage.commit_task_event(&snapshot(), &stored_event("event-02", 2), Some(&conflict));
    assert_eq!(result, Err(StorageError::IdempotencyConflict));
    assert_eq!(storage.counts().unwrap(), (1, 1));
    let _ = fs::remove_file(path);
}

#[test]
fn retention_device_hash_and_restart_recovery_are_bounded() {
    let path = db_path("retention");
    let storage = RemoteStorage::open_with_limits(
        &path,
        StorageLimits {
            max_tasks: 2,
            max_events: 2,
        },
    )
    .unwrap();
    for sequence in 1..=4 {
        storage
            .commit_task_event(
                &snapshot(),
                &stored_event(&format!("event-{sequence}"), sequence),
                None,
            )
            .unwrap();
    }
    assert_eq!(storage.counts().unwrap().1, 2);
    let device = StoredDevice {
        device_id: "mobile-01".into(),
        token_hash: [7; 32],
        display_name: "Phone".into(),
        platform: "ios".into(),
        identity_epoch: 3,
    };
    storage.upsert_device(&device).unwrap();
    assert_eq!(storage.device("mobile-01").unwrap().unwrap(), device);
    storage.set_identity_epoch(4).unwrap();
    assert_eq!(storage.identity_epoch().unwrap(), 4);
    let _ = fs::remove_file(path);
}

#[test]
fn corrupt_database_fails_closed() {
    let path = db_path("corrupt");
    fs::write(&path, b"not a sqlite database").unwrap();
    assert!(matches!(
        RemoteStorage::open(&path),
        Err(StorageError::Corrupt)
    ));
    let _ = fs::remove_file(path);
}

#[test]
fn recovery_atomically_marks_in_flight_task_as_desktop_restarted() {
    let path = db_path("recovery");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .commit_task_event(&snapshot(), &stored_event("event-recovery", 1), None)
        .unwrap();
    let recovered = storage
        .recover_non_terminal_tasks(2_000, "1970-01-01T00:00:02.000Z")
        .unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(
        recovered[0].state,
        pi_remote_control::protocol::RemoteTaskState::Failed
    );
    assert_eq!(
        recovered[0].error.as_ref().unwrap().code,
        pi_remote_control::protocol::RemoteTaskFailureCode::DesktopRestarted
    );
    assert!(storage.load_non_terminal_tasks().unwrap().is_empty());
    let events = storage.load_events("mobile-01", Some(1)).unwrap();
    assert!(events
        .iter()
        .any(|event| matches!(event.payload, RemoteEvent::TaskCompleted { .. })));
    let _ = fs::remove_file(path);
}

#[test]
fn rejects_event_metadata_mismatch_before_mutating_storage() {
    let path = db_path("event-metadata");
    let storage = RemoteStorage::open(&path).unwrap();
    let mut invalid = stored_event("event-invalid", 1);
    invalid.event_id = "event-outer-mismatch".into();

    let result = storage.commit_task_event(&snapshot(), &invalid, None);
    assert_eq!(result, Err(StorageError::Corrupt));
    assert_eq!(storage.counts().unwrap(), (0, 0));
    assert!(storage.load_non_terminal_tasks().unwrap().is_empty());

    let _ = fs::remove_file(path);
}

#[test]
fn schema_v2_persists_request_and_restores_idempotency_records() {
    let path = db_path("hydration");
    let storage = RemoteStorage::open(&path).unwrap();
    let idempotency = IdempotencyRecord {
        device_id: "mobile-01".into(),
        request_id: "request-01".into(),
        task_id: "task-01".into(),
        fingerprint: u64::MAX - 17,
        expires_at_ms: now_ms() + 60_000,
    };
    storage
        .commit_task_event_with_request(
            &snapshot(),
            &stored_event("event-01", 1),
            Some(&idempotency),
            Some(&request()),
        )
        .unwrap();

    let tasks = storage.load_tasks().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].request.as_ref().unwrap(), &request());
    assert_eq!(
        storage.load_idempotency(now_ms()).unwrap(),
        vec![idempotency]
    );

    let _ = fs::remove_file(path);
}

#[test]
fn schema_v1_is_migrated_without_discarding_existing_snapshots() {
    let path = db_path("schema-v1");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE tasks(task_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_json BLOB NOT NULL, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE devices(device_id TEXT PRIMARY KEY NOT NULL, token_hash BLOB NOT NULL, display_name TEXT NOT NULL, platform TEXT NOT NULL, identity_epoch INTEGER NOT NULL);
             CREATE TABLE idempotency(device_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, request_id));
             CREATE TABLE events(device_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT PRIMARY KEY NOT NULL, emitted_at_ms INTEGER NOT NULL, event_json BLOB NOT NULL, UNIQUE(device_id, sequence));
             INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
             INSERT INTO metadata(key, value) VALUES ('identity_epoch', '1');",
        )
        .unwrap();
    drop(connection);

    let storage = RemoteStorage::open(&path).unwrap();
    assert!(storage.load_tasks().unwrap().is_empty());
    let version: String = Connection::open(&path)
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "4");

    let _ = fs::remove_file(path);
}
