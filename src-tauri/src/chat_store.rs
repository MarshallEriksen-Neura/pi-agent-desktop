//! Chat-session persistence for the desktop app — SQLite at
//! `~/.pi/agent/desktop-chat.sqlite`, owned by the desktop app (never read by
//! the pi CLI). Message payloads are stored as an opaque JSON string so the
//! frontend owns the schema; Rust only indexes metadata for the session list.

use crate::remote_profiles::ExecutionBinding;
use pi_backend_core::chat_store::{configure_and_migrate, validate_session_payload};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub struct ChatDb(Mutex<Option<Connection>>);

impl Default for ChatDb {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn cache_source() -> String {
    "cache".into()
}

fn local_execution_binding() -> ExecutionBinding {
    ExecutionBinding::Local {
        target_id: "local".into(),
    }
}

fn open_db() -> Result<Connection, String> {
    let path = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("desktop-chat.sqlite");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut conn = Connection::open(&path).map_err(|e| e.to_string())?;
    // Legacy backfill is best-effort. A corrupt desktop.json must not make the
    // independent chat database unavailable.
    let legacy_project_root = crate::projects::last_project()
        .ok()
        .flatten()
        .map(|root| crate::projects::project_key(&root));
    configure_and_migrate(&mut conn, legacy_project_root.as_deref())
        .map_err(|error| error.to_string())?;
    Ok(conn)
}

/// Run `f` with the (lazily opened) connection.
fn with_db<T>(
    db: &State<'_, ChatDb>,
    f: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(open_db()?);
    }
    f(guard.as_mut().expect("connection just opened"))
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionMeta {
    pub id: String,
    pub name: String,
    pub session_path: String,
    pub preview: String,
    /// Project root this conversation belongs to (canonical key).
    pub project_root: String,
    pub execution_binding: ExecutionBinding,
    pub target_key: String,
    pub authority_session_id: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrashedSessionMeta {
    pub tombstone_id: i64,
    pub session_id: String,
    pub name: String,
    pub session_path: String,
    pub preview: String,
    pub project_root: String,
    pub execution_binding: ExecutionBinding,
    pub target_key: String,
    pub authority_session_id: Option<String>,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: i64,
    pub trash_file: Option<String>,
    pub trash_directory: Option<String>,
}

#[derive(Clone)]
struct RecycleRecord {
    meta: TrashedSessionMeta,
    messages: String,
}

fn decode_binding(value: String) -> ExecutionBinding {
    serde_json::from_str(&value).unwrap_or_else(|_| local_execution_binding())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionSave {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub session_path: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub project_root: String,
    #[serde(default = "local_execution_binding")]
    pub execution_binding: ExecutionBinding,
    #[serde(default)]
    pub authority_session_id: Option<String>,
    #[serde(default = "cache_source")]
    pub source: String,
    /// serialized ChatMessage[] — opaque to Rust
    pub messages: String,
    pub created_at: i64,
    #[serde(default)]
    pub preserve_updated_at: bool,
}

fn merge_native_sessions(
    conn: &mut Connection,
    project_root: &str,
    target_key: &str,
    sessions: Vec<pi_backend_core::session_discovery::NativeSessionMetadata>,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|error| error.to_string())?;
    let local_binding = serde_json::to_string(&local_execution_binding())
        .map_err(|error| format!("serialize local execution binding: {error}"))?;
    for session in sessions {
        let tombstoned: bool = transaction
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM chat_session_tombstones
                   WHERE target_key = ?1
                     AND (authority_session_id = ?2 OR session_path = ?3)
                 )",
                params![
                    target_key,
                    session.authority_session_id,
                    session.session_path
                ],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if tombstoned {
            continue;
        }

        let existing_id = transaction
            .query_row(
                "SELECT id FROM chat_sessions
                 WHERE target_key = ?1 AND authority_session_id = ?2 LIMIT 1",
                params![target_key, session.authority_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .or_else(|| {
                transaction
                    .query_row(
                        "SELECT id FROM chat_sessions
                         WHERE target_key = ?1 AND session_path = ?2 LIMIT 1",
                        params![target_key, session.session_path],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
            });

        if let Some(id) = existing_id {
            transaction
                .execute(
                    "UPDATE chat_sessions SET
                       authority_session_id = ?2,
                       session_path = ?3,
                       project_root = ?4,
                       name = CASE
                         WHEN TRIM(name) = '' AND TRIM(?5) <> '' THEN ?5
                         ELSE name
                       END,
                       preview = CASE
                         WHEN TRIM(preview) = '' AND TRIM(?6) <> '' THEN ?6
                         ELSE preview
                       END,
                       source = 'native',
                       created_at = MIN(created_at, ?7),
                       updated_at = ?8
                     WHERE id = ?1 AND target_key = ?9",
                    params![
                        id,
                        session.authority_session_id,
                        session.session_path,
                        project_root,
                        session.name,
                        session.preview,
                        session.created_at,
                        session.updated_at,
                        target_key
                    ],
                )
                .map_err(|error| error.to_string())?;
        } else {
            let id = format!("native:{target_key}:{}", session.authority_session_id);
            transaction
                .execute(
                    "INSERT INTO chat_sessions (
                       id, name, session_path, preview, messages, project_root,
                       execution_binding, target_key, authority_session_id, source,
                       created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, '[]', ?5, ?6, ?7, ?8, 'native', ?9, ?10)",
                    params![
                        id,
                        session.name,
                        session.session_path,
                        session.preview,
                        project_root,
                        local_binding,
                        target_key,
                        session.authority_session_id,
                        session.created_at,
                        session.updated_at
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// Sessions belonging to one project and execution target, most recently updated first.
#[tauri::command]
pub fn chat_sessions_list(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
) -> Result<Vec<ChatSessionMeta>, String> {
    let key = crate::projects::project_key(&project_root);
    with_db(&db, |conn| {
        if target_key == "local" {
            let discovered = crate::pi_sessions::discover_local_sessions(&project_root)?;
            merge_native_sessions(conn, &key, &target_key, discovered)?;
        }
        let mut stmt = conn
            .prepare(
                "SELECT id, name, session_path, preview, project_root, execution_binding,
                        target_key, authority_session_id, source, created_at, updated_at
                 FROM chat_sessions
                 WHERE project_root = ?1 AND target_key = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![key, target_key], |row| {
                Ok(ChatSessionMeta {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    session_path: row.get(2)?,
                    preview: row.get(3)?,
                    project_root: row.get(4)?,
                    execution_binding: row
                        .get::<_, String>(5)
                        .ok()
                        .and_then(|value| serde_json::from_str(&value).ok())
                        .unwrap_or_else(local_execution_binding),
                    target_key: row.get(6)?,
                    authority_session_id: row.get(7)?,
                    source: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })
}

/// Message payload (JSON string) for one scoped session, `None` if absent.
#[tauri::command]
pub fn chat_session_load(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
    id: String,
) -> Result<Option<String>, String> {
    let key = crate::projects::project_key(&project_root);
    with_db(&db, |conn| {
        conn.query_row(
            "SELECT messages FROM chat_sessions
             WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
            params![id, key, target_key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
    })
}

/// Upsert — `updated_at` is stamped server-side so ordering survives clock weirdness.
#[tauri::command]
pub fn chat_session_save(
    db: State<'_, ChatDb>,
    target_key: String,
    session: ChatSessionSave,
) -> Result<(), String> {
    validate_session_payload(&session.name, &session.preview, &session.messages)
        .map_err(|error| error.to_string())?;
    let key = crate::projects::project_key(&session.project_root);
    let execution_binding = serde_json::to_string(&session.execution_binding)
        .map_err(|error| format!("serialize execution binding: {error}"))?;
    let source = if session.source == "native" {
        "native"
    } else {
        "cache"
    };
    with_db(&db, |conn| {
        let changed = conn
            .execute(
                "INSERT INTO chat_sessions (
                   id, name, session_path, preview, messages, project_root, execution_binding,
                   target_key, authority_session_id, source, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   session_path = excluded.session_path,
                   preview = excluded.preview,
                   messages = excluded.messages,
                   project_root = excluded.project_root,
                   execution_binding = excluded.execution_binding,
                   authority_session_id = COALESCE(excluded.authority_session_id, chat_sessions.authority_session_id),
                   source = CASE WHEN chat_sessions.source = 'native' THEN 'native' ELSE excluded.source END,
                   updated_at = CASE WHEN ?13 THEN chat_sessions.updated_at ELSE excluded.updated_at END
                 WHERE chat_sessions.target_key = excluded.target_key",
                params![
                    session.id,
                    session.name,
                    session.session_path,
                    session.preview,
                    session.messages,
                    key,
                    execution_binding,
                    target_key,
                    session.authority_session_id,
                    source,
                    session.created_at,
                    now_ms(),
                    session.preserve_updated_at
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("session id belongs to a different execution target".into());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn chat_session_rename(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
    id: String,
    name: String,
) -> Result<(), String> {
    let key = crate::projects::project_key(&project_root);
    with_db(&db, |conn| {
        conn.execute(
            "UPDATE chat_sessions SET name = ?4, updated_at = ?5
             WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
            params![id, key, target_key, name, now_ms()],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub fn chat_session_delete(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
    id: String,
) -> Result<(), String> {
    let key = crate::projects::project_key(&project_root);
    let recycled = with_db(&db, |conn| {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        let row = transaction
            .query_row(
                "SELECT name, session_path, preview, execution_binding,
                        authority_session_id, source, messages, created_at, updated_at
                 FROM chat_sessions
                 WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
                params![id, key, target_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((name, session_path, preview, execution_binding, authority_session_id, source, messages, created_at, updated_at)) = row else {
            return Ok(None);
        };

        // A conversation that never materialized a Pi identity has no native
        // transcript to recover. It can still be deleted from the Desktop index,
        // but there is no meaningful recycle-bin file entry to create.
        let recyclable = authority_session_id.is_some() || !session_path.trim().is_empty();
        let mut tombstone_id = None;
        if recyclable {
            transaction
                .execute(
                    "DELETE FROM chat_session_tombstones
                     WHERE target_key = ?1 AND (
                       (?2 IS NOT NULL AND authority_session_id = ?2)
                       OR (?3 <> '' AND session_path = ?3)
                     )",
                    params![target_key, authority_session_id, session_path],
                )
                .map_err(|error| error.to_string())?;
            let deleted_at = now_ms();
            transaction
                .execute(
                    "INSERT INTO chat_session_tombstones (
                       target_key, authority_session_id, session_path,
                       session_id, name, preview, messages, project_root,
                       execution_binding, source, created_at, updated_at, deleted_at
                     ) VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                    params![
                        target_key,
                        authority_session_id,
                        session_path,
                        id,
                        name,
                        preview,
                        messages,
                        key,
                        execution_binding,
                        source,
                        created_at,
                        updated_at,
                        deleted_at,
                    ],
                )
                .map_err(|error| error.to_string())?;
            tombstone_id = Some(transaction.last_insert_rowid());
        }
        transaction
            .execute(
                "DELETE FROM chat_sessions
                 WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
                params![id, key, target_key],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(tombstone_id.map(|tombstone_id| (tombstone_id, session_path)))
    })?;

    // Row/tombstone first, file move second. A failed move leaves the original
    // transcript hidden by the tombstone, which is recoverable and safe; the
    // opposite order could strand a live DB row pointing at a missing file.
    if target_key == "local" {
        if let Some((tombstone_id, session_path)) = recycled {
            if !session_path.trim().is_empty() {
                if let Ok(outcome) = crate::pi_sessions::recycle_local_transcript(&key, &session_path) {
                    let file = outcome.file;
                    let directory = outcome.directory;
                    let _ = with_db(&db, |conn| {
                        conn.execute(
                            "UPDATE chat_session_tombstones
                             SET trash_file = ?2, trash_directory = ?3
                             WHERE tombstone_id = ?1",
                            params![tombstone_id, file, directory],
                        )
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                    });
                }
            }
        }
    }
    Ok(())
}

fn recycle_record(
    conn: &Connection,
    project_root: &str,
    target_key: &str,
    tombstone_id: i64,
) -> Result<Option<RecycleRecord>, String> {
    conn.query_row(
        "SELECT tombstone_id, session_id, name, COALESCE(session_path, ''), preview,
                project_root, execution_binding, target_key, authority_session_id,
                source, messages, created_at, updated_at, deleted_at,
                trash_file, trash_directory
         FROM chat_session_tombstones
         WHERE tombstone_id = ?1 AND project_root = ?2 AND target_key = ?3
           AND session_id IS NOT NULL",
        params![tombstone_id, project_root, target_key],
        |row| {
            let binding: String = row.get(6)?;
            Ok(RecycleRecord {
                meta: TrashedSessionMeta {
                    tombstone_id: row.get(0)?,
                    session_id: row.get(1)?,
                    name: row.get(2)?,
                    session_path: row.get(3)?,
                    preview: row.get(4)?,
                    project_root: row.get(5)?,
                    execution_binding: decode_binding(binding),
                    target_key: row.get(7)?,
                    authority_session_id: row.get(8)?,
                    source: row.get(9)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                    deleted_at: row.get(13)?,
                    trash_file: row.get(14)?,
                    trash_directory: row.get(15)?,
                },
                messages: row.get(10)?,
            })
        },
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn chat_session_trash_list(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
) -> Result<Vec<TrashedSessionMeta>, String> {
    let key = crate::projects::project_key(&project_root);
    with_db(&db, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT tombstone_id, session_id, name, COALESCE(session_path, ''), preview,
                        project_root, execution_binding, target_key, authority_session_id,
                        source, created_at, updated_at, deleted_at, trash_file, trash_directory
                 FROM chat_session_tombstones
                 WHERE project_root = ?1 AND target_key = ?2 AND session_id IS NOT NULL
                 ORDER BY deleted_at DESC",
            )
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map(params![key, target_key], |row| {
                let binding: String = row.get(6)?;
                Ok(TrashedSessionMeta {
                    tombstone_id: row.get(0)?,
                    session_id: row.get(1)?,
                    name: row.get(2)?,
                    session_path: row.get(3)?,
                    preview: row.get(4)?,
                    project_root: row.get(5)?,
                    execution_binding: decode_binding(binding),
                    target_key: row.get(7)?,
                    authority_session_id: row.get(8)?,
                    source: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    deleted_at: row.get(12)?,
                    trash_file: row.get(13)?,
                    trash_directory: row.get(14)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub fn chat_session_trash_restore(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
    tombstone_id: i64,
) -> Result<(), String> {
    let key = crate::projects::project_key(&project_root);
    let record = with_db(&db, |conn| recycle_record(conn, &key, &target_key, tombstone_id))?;
    let Some(record) = record else {
        return Ok(());
    };

    if target_key == "local" {
        crate::pi_sessions::restore_local_transcript(
            &key,
            &record.meta.session_path,
            record.meta.trash_file.as_deref(),
            record.meta.trash_directory.as_deref(),
        )?;
    }

    let execution_binding = serde_json::to_string(&record.meta.execution_binding)
        .map_err(|error| format!("serialize execution binding: {error}"))?;
    with_db(&db, |conn| {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO chat_sessions (
                   id, name, session_path, preview, messages, project_root,
                   execution_binding, target_key, authority_session_id, source,
                   created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    record.meta.session_id,
                    record.meta.name,
                    record.meta.session_path,
                    record.meta.preview,
                    record.messages,
                    record.meta.project_root,
                    execution_binding,
                    record.meta.target_key,
                    record.meta.authority_session_id,
                    record.meta.source,
                    record.meta.created_at,
                    record.meta.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM chat_session_tombstones
                 WHERE target_key = ?1 AND (
                    tombstone_id = ?2
                    OR (?3 IS NOT NULL AND authority_session_id = ?3)
                    OR (?4 <> '' AND session_path = ?4)
                 )",
                params![
                    record.meta.target_key,
                    record.meta.tombstone_id,
                    record.meta.authority_session_id,
                    record.meta.session_path,
                ],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    })
}

#[tauri::command]
pub fn chat_session_trash_purge(
    db: State<'_, ChatDb>,
    project_root: String,
    target_key: String,
    tombstone_id: i64,
) -> Result<(), String> {
    let key = crate::projects::project_key(&project_root);
    let record = with_db(&db, |conn| recycle_record(conn, &key, &target_key, tombstone_id))?;
    let Some(record) = record else {
        return Ok(());
    };
    if target_key == "local" {
        crate::pi_sessions::purge_local_transcript(
            &key,
            &record.meta.session_path,
            record.meta.trash_file.as_deref(),
            record.meta.trash_directory.as_deref(),
        )?;
    }
    with_db(&db, |conn| {
        conn.execute(
            "DELETE FROM chat_session_tombstones WHERE tombstone_id = ?1 AND project_root = ?2 AND target_key = ?3",
            params![record.meta.tombstone_id, key, target_key],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
}
