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
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = db.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        *guard = Some(open_db()?);
    }
    f(guard.as_ref().expect("connection just opened"))
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
    /// serialized ChatMessage[] — opaque to Rust
    pub messages: String,
    pub created_at: i64,
}

/// Sessions belonging to one project, most recently updated first (metadata
/// only — no messages). Scoping is by project so opening a project shows just
/// its own history instead of every conversation on the machine.
#[tauri::command]
pub fn chat_sessions_list(
    db: State<'_, ChatDb>,
    project_root: String,
) -> Result<Vec<ChatSessionMeta>, String> {
    let key = crate::projects::project_key(&project_root);
    with_db(&db, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, session_path, preview, project_root, execution_binding, created_at, updated_at
                 FROM chat_sessions WHERE project_root = ?1 ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![key], |r| {
                Ok(ChatSessionMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    session_path: r.get(2)?,
                    preview: r.get(3)?,
                    project_root: r.get(4)?,
                    execution_binding: r
                        .get::<_, String>(5)
                        .ok()
                        .and_then(|value| serde_json::from_str(&value).ok())
                        .unwrap_or_else(local_execution_binding),
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    })
}

/// Message payload (JSON string) for one session, `None` if it doesn't exist.
#[tauri::command]
pub fn chat_session_load(db: State<'_, ChatDb>, id: String) -> Result<Option<String>, String> {
    with_db(&db, |conn| {
        conn.query_row(
            "SELECT messages FROM chat_sessions WHERE id = ?1",
            params![id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    })
}

/// Upsert — `updated_at` is stamped server-side so ordering survives clock
/// weirdness in the webview.
#[tauri::command]
pub fn chat_session_save(db: State<'_, ChatDb>, session: ChatSessionSave) -> Result<(), String> {
    validate_session_payload(&session.name, &session.preview, &session.messages)
        .map_err(|error| error.to_string())?;
    let key = crate::projects::project_key(&session.project_root);
    let execution_binding = serde_json::to_string(&session.execution_binding)
        .map_err(|error| format!("serialize execution binding: {error}"))?;
    with_db(&db, |conn| {
        conn.execute(
            "INSERT INTO chat_sessions (id, name, session_path, preview, messages, project_root, execution_binding, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name = ?2, session_path = ?3, preview = ?4, messages = ?5, project_root = ?6, execution_binding = ?7, updated_at = ?9",
            params![
                session.id,
                session.name,
                session.session_path,
                session.preview,
                session.messages,
                key,
                execution_binding,
                session.created_at,
                now_ms()
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn chat_session_rename(db: State<'_, ChatDb>, id: String, name: String) -> Result<(), String> {
    with_db(&db, |conn| {
        conn.execute(
            "UPDATE chat_sessions SET name = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, name, now_ms()],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn chat_session_delete(db: State<'_, ChatDb>, id: String) -> Result<(), String> {
    with_db(&db, |conn| {
        conn.execute("DELETE FROM chat_sessions WHERE id = ?1", params![id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
}
