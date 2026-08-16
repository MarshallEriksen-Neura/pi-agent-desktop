//! Focused gates for schema v4, per-turn model binding, the gateway
//! remote-model allowlist, the desktop-host append bridge, and the redacted
//! host model catalog. Full-suite validation is release-only; these target
//! exactly the files changed by the model-sync work.

use pi_remote_control::models::{HostModelCatalog, ModelAllowlist};
use pi_remote_control::storage::{
    ConversationAcceptance, ConversationAppendAcceptance, RemoteStorage,
};
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};

fn db_path(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("ragcode-pi-g006-{name}-{}.db", std::process::id()));
    cleanup(&path);
    path
}

fn cleanup(path: &Path) {
    let _ = fs::remove_file(path);
    let _ = fs::remove_file(path.with_extension("db-wal"));
    let _ = fs::remove_file(path.with_extension("db-shm"));
}

fn create_acceptance(conversation_id: &str, request_id: &str, model_ref: Option<&str>) -> ConversationAcceptance {
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
        model_ref: model_ref.map(ToOwned::to_owned),
        created_at_ms: 1_000,
        created_at: "1970-01-01T00:00:01.000Z".into(),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: 61_000,
        event_id: format!("event-{request_id}"),
    }
}

fn append_acceptance(conversation_id: &str, request_id: &str, model_ref: Option<&str>) -> ConversationAppendAcceptance {
    ConversationAppendAcceptance {
        owner_device_id: "mobile-01".into(),
        conversation_id: conversation_id.into(),
        turn_id: format!("turn-{request_id}"),
        request_id: request_id.into(),
        user_message_id: format!("msg-{request_id}"),
        delivery_id: format!("delivery-{request_id}"),
        prompt: format!("prompt {request_id}"),
        context_json: br#"[]"#.to_vec(),
        model_ref: model_ref.map(ToOwned::to_owned),
        created_at_ms: 2_000,
        created_at: "1970-01-01T00:00:02.000Z".into(),
        request_fingerprint: format!("fingerprint-{request_id}"),
        idempotency_expires_at_ms: 62_000,
        event_id: format!("event-{request_id}"),
    }
}

#[test]
fn fresh_database_is_schema_v4_with_model_columns_and_allowlist_table() {
    let path = db_path("fresh");
    let storage = RemoteStorage::open(&path).unwrap();
    drop(storage);
    let connection = Connection::open(&path).unwrap();
    let version: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "4");
    let conversations_columns: Vec<String> = connection
        .prepare("PRAGMA table_info(conversations)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(conversations_columns.iter().any(|c| c == "default_model_ref"));
    let turns_columns: Vec<String> = connection
        .prepare("PRAGMA table_info(turns)")
        .unwrap()
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(turns_columns.iter().any(|c| c == "model_ref"));
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='remote_model_allowlist'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    cleanup(&path);
}

#[test]
fn schema_v3_database_migrates_to_v4_preserving_turns() {
    let path = db_path("v3up");
    // Build a real v4 database, then surgically downgrade it to v3: drop the
    // v4 columns/table and rewind the version marker. Reopening must restore
    // the columns and keep existing conversation rows intact.
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", None))
        .unwrap();
    drop(storage);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "ALTER TABLE conversations DROP COLUMN default_model_ref;
             ALTER TABLE turns DROP COLUMN model_ref;
             DROP TABLE remote_model_allowlist;
             UPDATE metadata SET value='3' WHERE key='schema_version';",
        )
        .unwrap();
    drop(connection);

    let storage = RemoteStorage::open(&path).unwrap();
    let appended = storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", Some("openai/gpt-4.1")))
        .unwrap();
    assert_eq!(appended.turn.model_ref.as_deref(), Some("openai/gpt-4.1"));
    let connection = Connection::open(&path).unwrap();
    let version: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "4");
    drop(connection);
    drop(storage);
    cleanup(&path);
}

#[test]
fn create_and_append_persist_immutable_turn_model_and_advance_conversation_default() {
    let path = db_path("modelref");
    let storage = RemoteStorage::open(&path).unwrap();

    let created = storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", Some("openai/gpt-4.1")))
        .unwrap();
    assert_eq!(created.turn.model_ref.as_deref(), Some("openai/gpt-4.1"));
    assert_eq!(
        created.conversation.default_model_ref.as_deref(),
        Some("openai/gpt-4.1")
    );

    let appended = storage
        .append_conversation_turn(&append_acceptance(
            "conv-01",
            "req-02",
            Some("anthropic/claude-sonnet-4"),
        ))
        .unwrap();
    assert_eq!(
        appended.turn.model_ref.as_deref(),
        Some("anthropic/claude-sonnet-4")
    );
    assert_eq!(
        appended.conversation.default_model_ref.as_deref(),
        Some("anthropic/claude-sonnet-4")
    );

    // Historical turn keeps its own immutable model; the reloaded snapshot
    // reports the advanced default.
    let snapshot = storage.load_conversation("mobile-01", "conv-01").unwrap().unwrap();
    assert_eq!(
        snapshot.default_model_ref.as_deref(),
        Some("anthropic/claude-sonnet-4")
    );
    let turn1 = snapshot
        .latest_turn
        .as_ref()
        .unwrap();
    assert_eq!(turn1.model_ref.as_deref(), Some("anthropic/claude-sonnet-4"));
    drop(storage);
    cleanup(&path);
}

#[test]
fn append_without_model_keeps_existing_conversation_default() {
    let path = db_path("modelkeep");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", Some("openai/gpt-4.1")))
        .unwrap();
    let appended = storage
        .append_conversation_turn(&append_acceptance("conv-01", "req-02", None))
        .unwrap();
    assert_eq!(appended.turn.model_ref, None);
    assert_eq!(
        appended.conversation.default_model_ref.as_deref(),
        Some("openai/gpt-4.1")
    );
    drop(storage);
    cleanup(&path);
}

#[test]
fn desktop_host_append_bridges_across_owners_idempotently() {
    let path = db_path("desktop");
    let storage = RemoteStorage::open(&path).unwrap();
    storage
        .create_conversation_turn(&create_acceptance("conv-01", "req-01", Some("openai/gpt-4.1")))
        .unwrap();

    let first = storage
        .append_conversation_turn_for_desktop(
            "conv-01",
            "follow-up from desktop",
            Vec::new(),
            None,
            "desktop-req-1".to_owned(),
            "desktop-evt-1".to_owned(),
        )
        .unwrap();
    assert_eq!(first.turn.state, pi_remote_control::conversation_protocol::RemoteTurnState::Queued);

    // Same requestId replays the original result instead of a second turn.
    let duplicate = storage
        .append_conversation_turn_for_desktop(
            "conv-01",
            "follow-up from desktop",
            Vec::new(),
            None,
            "desktop-req-1".to_owned(),
            "desktop-evt-1".to_owned(),
        )
        .unwrap();
    assert_eq!(duplicate.turn.turn_id, first.turn.turn_id);
    assert!(duplicate.duplicate);
    assert_eq!(storage.load_conversation("mobile-01", "conv-01").unwrap().unwrap().turn_count, 2);
    drop(storage);
    cleanup(&path);
}

#[test]
fn remote_model_allowlist_is_idempotent_and_listable() {
    let path = db_path("allowlist");
    let storage = RemoteStorage::open(&path).unwrap();
    let (allowed, duplicate) = storage
        .set_model_remote_allowed("openai/gpt-4.1", true, 1000)
        .unwrap();
    assert!(allowed);
    assert!(!duplicate);
    let (_, duplicate) = storage
        .set_model_remote_allowed("openai/gpt-4.1", true, 2000)
        .unwrap();
    assert!(duplicate);
    let (_, duplicate) = storage
        .set_model_remote_allowed("openai/gpt-4.1", false, 3000)
        .unwrap();
    assert!(!duplicate);
    let entries = storage.list_model_allowlist().unwrap();
    assert_eq!(entries, vec![("openai/gpt-4.1".to_owned(), false)]);
    drop(storage);
    cleanup(&path);
}

const MODELS_JSON: &str = r#"{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-responses",
      "apiKey": "sk-secret-never-export",
      "models": [
        { "id": "gpt-4.1", "name": "GPT-4.1", "reasoning": false, "contextWindow": 128000, "input": ["text", "image"] }
      ]
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "api": "anthropic-messages",
      "apiKey": "sk-ant-secret-never-export",
      "models": [
        { "id": "claude-sonnet-4", "name": "Claude Sonnet 4", "reasoning": true, "contextWindow": 200000 }
      ]
    }
  }
}"#;

fn models_json_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ragcode-pi-g006-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("models.json");
    fs::write(&path, MODELS_JSON).unwrap();
    path
}

#[test]
fn model_catalog_redacts_credentials_and_applies_allowlist() {
    let path = models_json_path("redact");
    let catalog = HostModelCatalog::new(Some(path.clone()), "openai".into(), "gpt-4.1".into())
        .expect("catalog wired");
    let allowlist = ModelAllowlist::new([("openai/gpt-4.1".to_owned(), true)]);

    let response = catalog.list(&allowlist).unwrap();
    assert_eq!(response.default_model_ref.as_deref(), Some("openai/gpt-4.1"));
    assert_eq!(response.models.len(), 2);
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(!serialized.contains("sk-secret"));
    assert!(!serialized.contains("sk-ant-secret"));
    assert!(!serialized.contains("https://"));
    assert!(!serialized.contains("baseUrl"));

    let openai = response
        .models
        .iter()
        .find(|model| model.provider == "openai")
        .unwrap();
    assert!(openai.remote_allowed);
    assert!(openai.is_default);
    assert_eq!(openai.model_ref, "openai/gpt-4.1");
    assert!(openai
        .input_kinds
        .iter()
        .any(|kind| matches!(kind, pi_remote_control::models::RemoteModelInputKind::Image)));
    // Host-configured models are remotely usable by default; only explicit
    // allowlist overrides flip them off.
    let anthropic = response
        .models
        .iter()
        .find(|model| model.provider == "anthropic")
        .unwrap();
    assert!(anthropic.remote_allowed);
    assert!(!anthropic.is_default);

    // An explicit `remote_enable false` override disables the model.
    let denied = ModelAllowlist::new([
        ("openai/gpt-4.1".to_owned(), true),
        ("anthropic/claude-sonnet-4".to_owned(), false),
    ]);
    let response = catalog.list(&denied).unwrap();
    let disabled = response
        .models
        .iter()
        .find(|model| model.provider == "anthropic")
        .unwrap();
    assert!(!disabled.remote_allowed);

    let _ = fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn model_catalog_discover_rejects_unknown_provider_and_add_upserts_atomically() {
    let dir = std::env::temp_dir().join(format!("ragcode-pi-g006-add-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("models.json");
    fs::write(&path, MODELS_JSON).unwrap();

    let catalog = HostModelCatalog::new(Some(path.clone()), String::new(), String::new()).unwrap();
    let allowlist = ModelAllowlist::new([]);

    let missing = catalog.discover("mistral");
    assert!(matches!(
        missing,
        Err(pi_remote_control::models::ModelCatalogError::ProviderNotFound)
    ));
    let discovered = catalog.discover("openai").unwrap();
    assert_eq!(discovered.candidates.len(), 1);
    assert_eq!(discovered.candidates[0].model_id, "gpt-4.1");

    let added = catalog
        .add(
            "openai",
            &[pi_remote_control::models::RemoteModelCandidate {
                model_id: "gpt-4.1-mini".into(),
                display_name: Some("GPT-4.1 mini".into()),
                reasoning: false,
                input_kinds: vec![pi_remote_control::models::RemoteModelInputKind::Text],
                context_window: None,
            }],
            &allowlist,
        )
        .unwrap();
    assert_eq!(added.added, vec!["openai/gpt-4.1-mini"]);
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("gpt-4.1-mini"));
    assert!(on_disk.contains("sk-secret-never-export"));
    let _ = fs::remove_dir_all(&dir);
}