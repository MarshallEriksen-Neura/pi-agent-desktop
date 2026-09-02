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
                       source = 'native',
                       created_at = MIN(created_at, ?5),
                       updated_at = MAX(updated_at, ?6)
                     WHERE id = ?1 AND target_key = ?7",
                    params![
                        id,
                        session.authority_session_id,
                        session.session_path,
                        project_root,
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
                     ) VALUES (?1, ?2, ?3, '', '[]', ?4, ?5, ?6, ?7, 'native', ?8, ?9)",
                    params![
                        id,
                        session.name,
                        session.session_path,
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
                   updated_at = excluded.updated_at
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
                    now_ms()
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
    with_db(&db, |conn| {
        let transaction = conn.transaction().map_err(|error| error.to_string())?;
        let identity = transaction
            .query_row(
                "SELECT authority_session_id, NULLIF(session_path, '')
                 FROM chat_sessions
                 WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
                params![id, key, target_key],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((authority_session_id, session_path)) = identity else {
            return Ok(());
        };
        if let Some(authority_session_id) = authority_session_id {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO chat_session_tombstones
                     (target_key, authority_session_id, session_path, deleted_at)
                     VALUES (?1, ?2, NULL, ?3)",
                    params![target_key, authority_session_id, now_ms()],
                )
                .map_err(|error| error.to_string())?;
        }
        if let Some(session_path) = session_path {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO chat_session_tombstones
                     (target_key, authority_session_id, session_path, deleted_at)
                     VALUES (?1, NULL, ?2, ?3)",
                    params![target_key, session_path, now_ms()],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "DELETE FROM chat_sessions
                 WHERE id = ?1 AND project_root = ?2 AND target_key = ?3",
                params![id, key, target_key],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    })
}
