use rusqlite::{Connection, TransactionBehavior};
use std::time::Duration;
use thiserror::Error;

pub const MAX_SESSION_MESSAGES_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_SESSION_NAME_BYTES: usize = 512;
pub const MAX_SESSION_PREVIEW_BYTES: usize = 8 * 1024;
pub const CHAT_SCHEMA_VERSION: i64 = 3;

#[derive(Debug, Error)]
pub enum ChatStoreError {
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("session field {field} exceeded {limit} bytes")]
    PayloadTooLarge { field: &'static str, limit: usize },
}

pub fn configure_and_migrate(
    connection: &mut Connection,
    legacy_project_root: Option<&str>,
) -> Result<(), ChatStoreError> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "journal_mode", "WAL")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL DEFAULT '',
           session_path TEXT NOT NULL DEFAULT '',
           preview TEXT NOT NULL DEFAULT '',
           messages TEXT NOT NULL DEFAULT '[]',
           project_root TEXT NOT NULL DEFAULT '',
           execution_binding TEXT NOT NULL DEFAULT '{\"kind\":\"local\",\"targetId\":\"local\"}',
           target_key TEXT NOT NULL DEFAULT 'local',
           authority_session_id TEXT,
           source TEXT NOT NULL DEFAULT 'cache',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )?;
    let has_project_root: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'project_root'",
        [],
        |row| row.get(0),
    )?;
    if has_project_root == 0 {
        transaction.execute_batch(
            "ALTER TABLE chat_sessions ADD COLUMN project_root TEXT NOT NULL DEFAULT '';",
        )?;
        if let Some(root) = legacy_project_root.filter(|root| !root.is_empty()) {
            transaction.execute(
                "UPDATE chat_sessions SET project_root = ?1 WHERE project_root = ''",
                [root],
            )?;
        }
    }
    let has_execution_binding: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'execution_binding'",
        [],
        |row| row.get(0),
    )?;
    if has_execution_binding == 0 {
        transaction.execute_batch(
            "ALTER TABLE chat_sessions ADD COLUMN execution_binding TEXT NOT NULL DEFAULT '{\"kind\":\"local\",\"targetId\":\"local\"}';",
        )?;
    }
    let has_target_key: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'target_key'",
        [],
        |row| row.get(0),
    )?;
    if has_target_key == 0 {
        transaction.execute_batch(
            "ALTER TABLE chat_sessions ADD COLUMN target_key TEXT NOT NULL DEFAULT 'local';
             UPDATE chat_sessions
             SET target_key = CASE
               WHEN json_valid(execution_binding)
                AND json_extract(execution_binding, '$.kind') = 'ssh'
                AND COALESCE(json_extract(execution_binding, '$.profileId'), '') <> ''
               THEN 'ssh:' || json_extract(execution_binding, '$.profileId')
               ELSE 'local'
             END;",
        )?;
    }
    let has_authority_session_id: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'authority_session_id'",
        [],
        |row| row.get(0),
    )?;
    if has_authority_session_id == 0 {
        transaction
            .execute_batch("ALTER TABLE chat_sessions ADD COLUMN authority_session_id TEXT;")?;
    }
    let has_source: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'source'",
        [],
        |row| row.get(0),
    )?;
    if has_source == 0 {
        transaction.execute_batch(
            "ALTER TABLE chat_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'cache';",
        )?;
    }
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_session_tombstones (
           tombstone_id INTEGER PRIMARY KEY AUTOINCREMENT,
           target_key TEXT NOT NULL,
           authority_session_id TEXT,
           session_path TEXT,
           deleted_at INTEGER NOT NULL,
           CHECK (authority_session_id IS NOT NULL OR session_path IS NOT NULL)
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_tombstone_authority
           ON chat_session_tombstones (target_key, authority_session_id)
           WHERE authority_session_id IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_tombstone_path
           ON chat_session_tombstones (target_key, session_path)
           WHERE session_path IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_authority
           ON chat_sessions (target_key, authority_session_id)
           WHERE authority_session_id IS NOT NULL;
         CREATE INDEX IF NOT EXISTS idx_chat_sessions_scope
           ON chat_sessions (target_key, project_root, updated_at DESC);",
    )?;
    transaction.pragma_update(None, "user_version", CHAT_SCHEMA_VERSION)?;
    transaction.commit()?;
    Ok(())
}

pub fn validate_session_payload(
    name: &str,
    preview: &str,
    messages: &str,
) -> Result<(), ChatStoreError> {
    validate_size("name", name, MAX_SESSION_NAME_BYTES)?;
    validate_size("preview", preview, MAX_SESSION_PREVIEW_BYTES)?;
    validate_size("messages", messages, MAX_SESSION_MESSAGES_BYTES)
}

fn validate_size(field: &'static str, value: &str, limit: usize) -> Result<(), ChatStoreError> {
    if value.len() > limit {
        return Err(ChatStoreError::PayloadTooLarge { field, limit });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn configures_and_migrates_database_transactionally() {
        let directory = temp_dir("chat-migration");
        let path = directory.join("chat.sqlite");
        let mut connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE chat_sessions (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL DEFAULT '',
                   session_path TEXT NOT NULL DEFAULT '',
                   preview TEXT NOT NULL DEFAULT '',
                   messages TEXT NOT NULL DEFAULT '[]',
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 INSERT INTO chat_sessions (id, created_at, updated_at)
                 VALUES ('legacy', 1, 1);",
            )
            .unwrap();
        configure_and_migrate(&mut connection, Some("D:/legacy-project")).unwrap();
        configure_and_migrate(&mut connection, None).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        let journal: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(version, CHAT_SCHEMA_VERSION);
        assert_eq!(journal.to_ascii_lowercase(), "wal");
        let project_root: String = connection
            .query_row(
                "SELECT project_root FROM chat_sessions WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(project_root, "D:/legacy-project");
        let execution_binding: String = connection
            .query_row(
                "SELECT execution_binding FROM chat_sessions WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(execution_binding, r#"{"kind":"local","targetId":"local"}"#);
        drop(connection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_oversized_session_payload() {
        let messages = "x".repeat(MAX_SESSION_MESSAGES_BYTES + 1);
        assert!(matches!(
            validate_session_payload("name", "preview", &messages),
            Err(ChatStoreError::PayloadTooLarge {
                field: "messages",
                ..
            })
        ));
    }

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("pi-backend-{label}-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }
}
