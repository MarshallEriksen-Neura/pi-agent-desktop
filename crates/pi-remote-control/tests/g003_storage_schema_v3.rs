use pi_remote_control::storage::{
    ConversationAcceptance, ConversationAppendAcceptance, MigrationFailurePoint, MigrationOptions,
    RemoteStorage, StorageError,
};
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::{Path, PathBuf};

fn db_path(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("ragcode-pi-g003-{name}-{}.db", std::process::id()));
    cleanup(&path);
    path
}

fn cleanup(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));
    if let Some(parent) = path.parent() {
        if let Some(file_name) = path.file_name().and_then(|name| name.to_str()) {
            let _ = fs::remove_file(parent.join(format!("{file_name}.pre-v3-schema-v1.sqlite")));
            let _ = fs::remove_file(parent.join(format!("{file_name}.pre-v3-schema-v2.sqlite")));
        }
    }
}

fn restore_path(path: &Path, version: i64) -> PathBuf {
    let file_name = path.file_name().unwrap().to_str().unwrap();
    path.parent()
        .unwrap()
        .join(format!("{file_name}.pre-v3-schema-v{version}.sqlite"))
}

fn snapshot_bytes() -> Vec<u8> {
    include_bytes!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/snapshot-awaiting-input.json"
    )
    .to_vec()
}

fn create_schema_v1(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE tasks(task_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_json BLOB NOT NULL, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE devices(device_id TEXT PRIMARY KEY NOT NULL, token_hash BLOB NOT NULL, display_name TEXT NOT NULL, platform TEXT NOT NULL, identity_epoch INTEGER NOT NULL);
             CREATE TABLE idempotency(device_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, request_id));
             CREATE TABLE events(device_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT PRIMARY KEY NOT NULL, emitted_at_ms INTEGER NOT NULL, event_json BLOB NOT NULL, UNIQUE(device_id, sequence));
             INSERT INTO metadata(key, value) VALUES ('schema_version', '1');
             INSERT INTO metadata(key, value) VALUES ('identity_epoch', '1');",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO tasks(task_id, owner_device_id, project_id, state, snapshot_json, updated_at_ms)
             VALUES ('task-v1', 'mobile-01', 'project-01', 'awaiting_input', ?1, 1234)",
            params![snapshot_bytes()],
        )
        .unwrap();
}

fn create_schema_v2(path: &Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE devices(device_id TEXT PRIMARY KEY NOT NULL, token_hash BLOB NOT NULL, display_name TEXT NOT NULL, platform TEXT NOT NULL, identity_epoch INTEGER NOT NULL);
             CREATE TABLE tasks(task_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_json BLOB NOT NULL, request_json BLOB, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE idempotency(device_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, request_id));
             CREATE TABLE events(device_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT PRIMARY KEY NOT NULL, emitted_at_ms INTEGER NOT NULL, event_json BLOB NOT NULL, UNIQUE(device_id, sequence));
             CREATE INDEX idx_tasks_updated ON tasks(updated_at_ms);
             CREATE INDEX idx_events_emitted ON events(emitted_at_ms);
             INSERT INTO metadata(key, value) VALUES ('schema_version', '2');
             INSERT INTO metadata(key, value) VALUES ('identity_epoch', '1');",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO tasks(task_id, owner_device_id, project_id, state, snapshot_json, request_json, updated_at_ms)
             VALUES ('task-v2', 'mobile-01', 'project-01', 'awaiting_input', ?1, NULL, 1234)",
            params![snapshot_bytes()],
        )
        .unwrap();
}

fn table_names(path: &Path) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type='table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn schema_version(path: &Path) -> Option<String> {
    Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()
        .unwrap()
}

fn create_acceptance(conversation_id: &str, request_id: &str) -> ConversationAcceptance {
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
        created_at_ms: 1_000,
        created_at: "1970-01-01T00:00:01.000Z".into(),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: 61_000,
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
        created_at: format!("unix-ms:{created_at_ms}"),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: created_at_ms + 60_000,
        event_id: format!("event-{request_id}"),
    }
}

#[test]
fn new_database_creates_schema_v3_without_restore_point() {
    let path = db_path("new");
    let _storage = RemoteStorage::open(&path).unwrap();

    assert_eq!(schema_version(&path).as_deref(), Some("3"));
    let tables = table_names(&path);
    for required in [
        "conversations",
        "conversation_sessions",
        "turns",
        "messages",
        "conversation_interactions",
        "conversation_idempotency",
    ] {
        assert!(tables.iter().any(|table| table == required), "{required}");
    }
    assert_eq!(
        tables,
        vec![
            "conversation_idempotency",
            "conversation_interactions",
            "conversation_sessions",
            "conversations",
            "devices",
            "events",
            "idempotency",
            "messages",
            "metadata",
            "tasks",
            "turns",
        ]
    );
    assert!(!restore_path(&path, 2).exists());

    cleanup(&path);
}

#[test]
fn schema_v3_foreign_keys_and_private_session_table_are_enforced() {
    let path = db_path("fk");
    let _storage = RemoteStorage::open(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();

    let err = connection
        .execute(
            "INSERT INTO conversation_sessions(conversation_id, session_id, relative_ref, pi_version, format_fingerprint, state, updated_at_ms)
             VALUES ('missing', 'sess-missing', 'private/ref', '0.84.1', 'v3', 'bound', 1)",
            [],
        )
        .unwrap_err();
    assert!(matches!(err, rusqlite::Error::SqliteFailure(_, _)));

    connection
        .execute(
            "INSERT INTO conversations(conversation_id, owner_device_id, project_id, status, title, created_at_ms, updated_at_ms, archived_at_ms)
             VALUES ('conv-01', 'mobile-01', 'project-01', 'idle', 'Task', 1, 1, NULL)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO turns(turn_id, conversation_id, request_id, state, delivery_state, context_json, error_json, created_at_ms, started_at_ms, finished_at_ms)
             VALUES ('turn-01', 'conv-01', 'req-01', 'queued', 'queued', X'7B7D', NULL, 1, NULL, NULL)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO messages(message_id, conversation_id, turn_id, ordinal, role, status, content_blob, created_at_ms, completed_at_ms)
             VALUES ('msg-01', 'conv-01', 'turn-01', 1, 'user', 'complete', X'6869', 1, 1)",
            [],
        )
        .unwrap();
    let duplicate = connection
        .execute(
            "INSERT INTO messages(message_id, conversation_id, turn_id, ordinal, role, status, content_blob, created_at_ms, completed_at_ms)
             VALUES ('msg-02', 'conv-01', 'turn-01', 1, 'assistant', 'complete', X'6869', 2, 2)",
            [],
        )
        .unwrap_err();
    assert!(matches!(duplicate, rusqlite::Error::SqliteFailure(_, _)));

    cleanup(&path);
}

#[test]
fn schema_v2_upgrade_creates_sqlite_restore_point_and_preserves_v1_rows_byte_for_byte() {
    let path = db_path("v2");
    create_schema_v2(&path);
    let before = snapshot_bytes();

    let _storage = RemoteStorage::open(&path).unwrap();

    assert_eq!(schema_version(&path).as_deref(), Some("3"));
    assert!(restore_path(&path, 2).exists());
    let connection = Connection::open(&path).unwrap();
    let after: Vec<u8> = connection
        .query_row(
            "SELECT snapshot_json FROM tasks WHERE task_id='task-v2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);
    let restore = Connection::open(restore_path(&path, 2)).unwrap();
    let restore_version: String = restore
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(restore_version, "2");
    let restore_check: String = restore
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .unwrap();
    assert_eq!(restore_check, "ok");

    cleanup(&path);
}

#[test]
fn schema_v1_upgrade_adds_request_column_and_does_not_project_tasks_into_conversations() {
    let path = db_path("v1");
    create_schema_v1(&path);
    let before = snapshot_bytes();

    let _storage = RemoteStorage::open(&path).unwrap();

    let connection = Connection::open(&path).unwrap();
    let after: Vec<u8> = connection
        .query_row(
            "SELECT snapshot_json FROM tasks WHERE task_id='task-v1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let conversations: i64 = connection
        .query_row("SELECT COUNT(*) FROM conversations", [], |row| row.get(0))
        .unwrap();
    let has_request_column = connection
        .prepare("PRAGMA table_info(tasks)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .any(|column| column.unwrap() == "request_json");
    assert_eq!(after, before);
    assert_eq!(conversations, 0);
    assert!(has_request_column);
    assert!(restore_path(&path, 1).exists());

    cleanup(&path);
}

#[test]
fn forced_failure_after_v3_ddl_rolls_back_every_table_and_version_change() {
    let path = db_path("rollback");
    create_schema_v2(&path);
    let result = RemoteStorage::open_with_limits_and_migration_options(
        &path,
        Default::default(),
        MigrationOptions {
            failure_point: Some(MigrationFailurePoint::AfterV3Tables),
        },
    );

    assert!(matches!(result, Err(StorageError::Database)));
    assert_eq!(schema_version(&path).as_deref(), Some("2"));
    let tables = table_names(&path);
    assert!(!tables.iter().any(|name| name == "conversations"));
    assert!(!tables.iter().any(|name| name == "turns"));
    assert!(restore_path(&path, 2).exists());

    cleanup(&path);
}

#[test]
fn restore_point_failure_prevents_migration() {
    let path = db_path("restore-failure");
    create_schema_v2(&path);
    let result = RemoteStorage::open_with_limits_and_migration_options(
        &path,
        Default::default(),
        MigrationOptions {
            failure_point: Some(MigrationFailurePoint::BeforeRestorePoint),
        },
    );

    assert!(matches!(result, Err(StorageError::RestorePoint)));
    assert_eq!(schema_version(&path).as_deref(), Some("2"));
    assert!(!restore_path(&path, 2).exists());
    assert!(!table_names(&path)
        .iter()
        .any(|name| name == "conversations"));

    cleanup(&path);
}

#[test]
fn downgrade_after_schema_v3_is_refused_without_deleting_data() {
    let path = db_path("downgrade");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             INSERT INTO metadata(key, value) VALUES ('schema_version', '4');
             CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY NOT NULL);",
        )
        .unwrap();

    let result = RemoteStorage::open(&path);

    assert!(matches!(
        result,
        Err(StorageError::DowngradeRefused {
            found: 4,
            supported: 3,
        })
    ));
    assert_eq!(schema_version(&path).as_deref(), Some("4"));
    assert!(table_names(&path)
        .iter()
        .any(|name| name == "conversations"));

    cleanup(&path);
}

#[test]
fn create_conversation_persists_acceptance_turn_message_idempotency_and_outbox_atomically() {
    let path = db_path("create-atomic");
    let storage = RemoteStorage::open(&path).unwrap();
    let acceptance = create_acceptance("conv-01", "req-01");

    let response = storage.create_conversation_turn(&acceptance).unwrap();

    assert_eq!(response.conversation.conversation_id, "conv-01");
    assert_eq!(response.conversation.owner_device_id, "mobile-01");
    assert_eq!(response.conversation.title, None);
    assert_eq!(response.turn.turn_id, "turn-req-01");
    assert_eq!(response.user_message.text, "prompt req-01");
    assert_eq!(
        response.delivery.status,
        pi_remote_control::conversation_protocol::RemoteTurnDeliveryState::Accepted
    );
    let connection = Connection::open(&path).unwrap();
    let counts: (i64, i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM conversations),
                (SELECT COUNT(*) FROM turns),
                (SELECT COUNT(*) FROM messages),
                (SELECT COUNT(*) FROM conversation_idempotency),
                (SELECT COUNT(*) FROM events)",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(counts, (1, 1, 1, 1, 1));
    assert!(storage.load_events("mobile-01", None).unwrap().is_empty());

    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json)
             VALUES ('mobile-01', 2, 'event-v2-shared-kind', 2, ?1)",
            params![br#"{"eventId":"event-v2-shared-kind","emittedAt":"2026-08-12T00:00:02.000Z","sequence":2,"deviceId":"mobile-01","conversationId":"conv-req-01","kind":"snapshot_required","reason":"gap_detected"}"#],
        )
        .unwrap();
    assert!(
        storage.load_events("mobile-01", None).unwrap().is_empty(),
        "v1 replay must ignore v2 events even when the kind spelling is shared"
    );
    let sequence_pair: (i64, i64) = connection
        .query_row(
            "SELECT sequence, json_extract(CAST(event_json AS TEXT), '$.sequence') FROM events WHERE event_id='event-req-01'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(sequence_pair, (1, 1));

    cleanup(&path);
}

#[test]
fn duplicate_create_and_append_are_idempotent_but_conflicts_do_not_mutate() {
    let path = db_path("idempotency");
    let storage = RemoteStorage::open(&path).unwrap();
    let acceptance = create_acceptance("conv-01", "req-01");
    storage.create_conversation_turn(&acceptance).unwrap();

    let duplicate = storage.create_conversation_turn(&acceptance).unwrap();
    assert_eq!(duplicate.turn.turn_id, "turn-req-01");

    let mut conflict = acceptance.clone();
    conflict.turn_id = "turn-conflict".into();
    assert_eq!(
        storage.create_conversation_turn(&conflict).unwrap_err(),
        StorageError::IdempotencyConflict
    );

    let append = append_acceptance("conv-01", "req-02", 2_000);
    let appended = storage.append_conversation_turn(&append).unwrap();
    assert!(!appended.duplicate);
    let duplicate_append = storage.append_conversation_turn(&append).unwrap();
    assert!(duplicate_append.duplicate);
    assert_eq!(duplicate_append.turn.turn_id, appended.turn.turn_id);

    let mut append_conflict = append.clone();
    append_conflict.turn_id = "turn-conflict-append".into();
    assert_eq!(
        storage
            .append_conversation_turn(&append_conflict)
            .unwrap_err(),
        StorageError::IdempotencyConflict
    );
    let connection = Connection::open(&path).unwrap();
    let counts: (i64, i64, i64) = connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM turns),
                (SELECT COUNT(*) FROM messages),
                (SELECT COUNT(*) FROM events)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(counts, (2, 2, 2));

    cleanup(&path);
}

#[test]
fn owner_scoped_load_list_and_message_pages_hide_other_devices() {
    let path = db_path("owner-scope");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01"))
        .unwrap();
    storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", 2_000))
        .unwrap();

    assert!(storage
        .load_conversation("mobile-02", "conv-01")
        .unwrap()
        .is_none());
    assert!(storage
        .list_conversations("mobile-02", 10)
        .unwrap()
        .is_empty());
    assert!(storage
        .load_conversation_messages("mobile-02", "conv-01", None, 10)
        .unwrap()
        .is_none());

    let snapshot = storage
        .load_conversation("mobile-01", "conv-01")
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.turn_count, 2);
    assert_eq!(snapshot.message_count, 2);
    let page = storage
        .load_conversation_messages("mobile-01", "conv-01", None, 1)
        .unwrap()
        .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(page.next_cursor.as_deref(), Some("2"));

    cleanup(&path);
}
