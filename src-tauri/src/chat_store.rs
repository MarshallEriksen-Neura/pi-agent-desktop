//! Chat-session persistence for the desktop app — SQLite at
//! `~/.pi/agent/desktop-chat.sqlite`, owned by the desktop app (never read by
//! the pi CLI). Message payloads are stored as an opaque JSON string so the
//! frontend owns the schema; Rust only indexes metadata for the session list.

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

fn open_db() -> Result<Connection, String> {
    let path = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("desktop-chat.sqlite");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|e| e.to_string())?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_sessions (
           id TEXT PRIMARY KEY,
           name TEXT NOT NULL DEFAULT '',
           session_path TEXT NOT NULL DEFAULT '',
           preview TEXT NOT NULL DEFAULT '',
           messages TEXT NOT NULL DEFAULT '[]',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
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
    /// serialized ChatMessage[] — opaque to Rust
    pub messages: String,
    pub created_at: i64,
}

/// All sessions, most recently updated first (metadata only — no messages).
#[tauri::command]
pub fn chat_sessions_list(db: State<'_, ChatDb>) -> Result<Vec<ChatSessionMeta>, String> {
    with_db(&db, |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT id, name, session_path, preview, created_at, updated_at
                 FROM chat_sessions ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ChatSessionMeta {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    session_path: r.get(2)?,
                    preview: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
    with_db(&db, |conn| {
        conn.execute(
            "INSERT INTO chat_sessions (id, name, session_path, preview, messages, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               name = ?2, session_path = ?3, preview = ?4, messages = ?5, updated_at = ?7",
            params![
                session.id,
                session.name,
                session.session_path,
                session.preview,
                session.messages,
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
