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
           project_root TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )
    .map_err(|e| e.to_string())?;
    migrate_project_root(&conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_chat_sessions_project
           ON chat_sessions (project_root, updated_at DESC);",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// Databases written before sessions were scoped per project have no
/// `project_root` column. Add it, then backfill every existing row with the
/// last-opened project — those transcripts were, in practice, produced there,
/// and an empty key would hide them from every project's list.
fn migrate_project_root(conn: &Connection) -> Result<(), String> {
    let present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('chat_sessions') WHERE name = 'project_root'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if present > 0 {
        return Ok(());
    }
    conn.execute_batch(
        "ALTER TABLE chat_sessions ADD COLUMN project_root TEXT NOT NULL DEFAULT '';",
    )
    .map_err(|e| e.to_string())?;
    if let Some(root) = crate::projects::last_project() {
        conn.execute(
            "UPDATE chat_sessions SET project_root = ?1 WHERE project_root = ''",
            params![crate::projects::project_key(&root)],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
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
                "SELECT id, name, session_path, preview, project_root, created_at, updated_at
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
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
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
    let key = crate::projects::project_key(&session.project_root);
    with_db(&db, |conn| {
        conn.execute(
            "INSERT INTO chat_sessions (id, name, session_path, preview, messages, project_root, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               name = ?2, session_path = ?3, preview = ?4, messages = ?5, project_root = ?6, updated_at = ?8",
            params![
                session.id,
                session.name,
                session.session_path,
                session.preview,
                session.messages,
                key,
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
