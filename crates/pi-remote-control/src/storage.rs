//! Dedicated remote-control persistence.
//!
//! The gateway never shares the desktop chat database.  Every task snapshot,
//! event and idempotency record that crosses this boundary is committed in a
//! single SQLite transaction so a restart cannot expose an event without its
//! authoritative snapshot (or the reverse).

use crate::protocol::{
    RemoteEvent, RemoteEventBase, RemoteTaskCreateRequest, RemoteTaskError, RemoteTaskFailureCode,
    RemoteTaskSnapshot, RemoteTaskState, RemoteTaskTerminalState,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const STORAGE_SCHEMA_VERSION: i64 = 2;
pub const MAX_TASKS: usize = 500;
pub const MAX_EVENTS: usize = 10_000;
pub const TASK_RETENTION_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const EVENT_RETENTION_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
pub const MAX_EVENT_BYTES: usize = 256 * 1024;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StorageError {
    Corrupt,
    Database,
    PayloadTooLarge,
    InvalidKey,
    IdempotencyConflict,
}

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Corrupt => "remote-control storage is corrupt",
            Self::Database => "remote-control storage operation failed",
            Self::PayloadTooLarge => "remote-control storage payload is too large",
            Self::InvalidKey => "remote-control storage key is invalid",
            Self::IdempotencyConflict => "remote-control idempotency key conflicts",
        })
    }
}

impl std::error::Error for StorageError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredEvent {
    pub device_id: String,
    pub sequence: u64,
    pub event_id: String,
    pub emitted_at_ms: u64,
    pub payload: RemoteEvent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredTask {
    pub snapshot: RemoteTaskSnapshot,
    pub request: Option<RemoteTaskCreateRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdempotencyRecord {
    pub device_id: String,
    pub request_id: String,
    pub task_id: String,
    pub fingerprint: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredDevice {
    pub device_id: String,
    pub token_hash: [u8; 32],
    pub display_name: String,
    pub platform: String,
    pub identity_epoch: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct StorageLimits {
    pub max_tasks: usize,
    pub max_events: usize,
}

impl Default for StorageLimits {
    fn default() -> Self {
        Self {
            max_tasks: MAX_TASKS,
            max_events: MAX_EVENTS,
        }
    }
}

impl StorageLimits {
    fn bounded(self) -> Self {
        Self {
            max_tasks: if self.max_tasks == 0 || self.max_tasks > MAX_TASKS {
                MAX_TASKS
            } else {
                self.max_tasks
            },
            max_events: if self.max_events == 0 || self.max_events > MAX_EVENTS {
                MAX_EVENTS
            } else {
                self.max_events
            },
        }
    }
}

pub struct RemoteStorage {
    path: PathBuf,
    connection: Mutex<Connection>,
    limits: StorageLimits,
}

impl RemoteStorage {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, StorageError> {
        Self::open_with_limits(path, StorageLimits::default())
    }

    pub fn open_with_limits(
        path: impl Into<PathBuf>,
        limits: StorageLimits,
    ) -> Result<Self, StorageError> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| StorageError::Database)?;
        }
        let mut connection = Connection::open(&path).map_err(map_database_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(map_database_error)?;
        configure_and_migrate(&mut connection)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
            limits: limits.bounded(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn commit_task_event(
        &self,
        snapshot: &RemoteTaskSnapshot,
        event: &StoredEvent,
        idempotency: Option<&IdempotencyRecord>,
    ) -> Result<(), StorageError> {
        self.commit_task_event_with_request(snapshot, event, idempotency, None)
    }

    pub fn commit_task_event_with_request(
        &self,
        snapshot: &RemoteTaskSnapshot,
        event: &StoredEvent,
        idempotency: Option<&IdempotencyRecord>,
        request: Option<&RemoteTaskCreateRequest>,
    ) -> Result<(), StorageError> {
        validate_event_metadata(event)?;
        let snapshot_json = serde_json::to_vec(snapshot).map_err(|_| StorageError::Database)?;
        let event_json = serde_json::to_vec(&event.payload).map_err(|_| StorageError::Database)?;
        let request_json = request
            .map(|request| {
                request
                    .validate()
                    .map_err(|_| StorageError::Corrupt)
                    .and_then(|_| serde_json::to_vec(request).map_err(|_| StorageError::Database))
            })
            .transpose()?;
        if snapshot_json.len() > MAX_SNAPSHOT_BYTES
            || event_json.len() > MAX_EVENT_BYTES
            || request_json
                .as_ref()
                .is_some_and(|value| value.len() > MAX_REQUEST_BYTES)
        {
            return Err(StorageError::PayloadTooLarge);
        }
        validate_key(&event.device_id)?;
        validate_key(&event.event_id)?;
        let state = serde_json::to_value(&snapshot.state)
            .map_err(|_| StorageError::Database)?
            .as_str()
            .ok_or(StorageError::Database)?
            .to_owned();
        let now = now_ms();
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        transaction
            .execute(
                "INSERT INTO tasks(task_id, owner_device_id, project_id, state, snapshot_json, request_json, updated_at_ms)\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)\
                 ON CONFLICT(task_id) DO UPDATE SET owner_device_id=excluded.owner_device_id,\
                 project_id=excluded.project_id, state=excluded.state, snapshot_json=excluded.snapshot_json,\
                 request_json=COALESCE(excluded.request_json, tasks.request_json),\
                 updated_at_ms=excluded.updated_at_ms",
                params![
                    snapshot.task_id,
                    snapshot.owner_device_id,
                    snapshot.project_id,
                    state,
                    snapshot_json,
                    request_json,
                    now,
                ],
            )
            .map_err(map_database_error)?;
        transaction
            .execute(
                "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![event.device_id, event.sequence, event.event_id, event.emitted_at_ms, event_json],
            )
            .map_err(map_database_error)?;
        if let Some(idempotency) = idempotency {
            validate_key(&idempotency.device_id)?;
            validate_key(&idempotency.request_id)?;
            validate_key(&idempotency.task_id)?;
            let existing = transaction
                .query_row(
                    "SELECT task_id, fingerprint, expires_at_ms FROM idempotency WHERE device_id=?1 AND request_id=?2",
                    params![idempotency.device_id, idempotency.request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .optional()
                .map_err(map_database_error)?;
            match existing {
                Some((task_id, fingerprint, expires_at_ms))
                    if task_id != idempotency.task_id
                        || fingerprint as u64 != idempotency.fingerprint
                        || expires_at_ms as u64 != idempotency.expires_at_ms =>
                {
                    return Err(StorageError::IdempotencyConflict);
                }
                None => {
                    transaction
                        .execute(
                            "INSERT INTO idempotency(device_id, request_id, task_id, fingerprint, expires_at_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                            params![
                                idempotency.device_id,
                                idempotency.request_id,
                                idempotency.task_id,
                                i64::from_ne_bytes(idempotency.fingerprint.to_ne_bytes()),
                                idempotency.expires_at_ms as i64
                            ],
                        )
                        .map_err(map_database_error)?;
                }
                _ => {}
            }
        }
        retain_locked(&transaction, self.limits, now)?;
        transaction.commit().map_err(map_database_error)
    }

    pub fn upsert_device(&self, device: &StoredDevice) -> Result<(), StorageError> {
        validate_key(&device.device_id)?;
        validate_key(&device.display_name)?;
        validate_key(&device.platform)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute(
                "INSERT INTO devices(device_id, token_hash, display_name, platform, identity_epoch) VALUES (?1, ?2, ?3, ?4, ?5)\
                 ON CONFLICT(device_id) DO UPDATE SET token_hash=excluded.token_hash, display_name=excluded.display_name, platform=excluded.platform, identity_epoch=excluded.identity_epoch",
                params![device.device_id, device.token_hash.as_slice(), device.display_name, device.platform, device.identity_epoch as i64],
            )
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn device(&self, device_id: &str) -> Result<Option<StoredDevice>, StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT token_hash, display_name, platform, identity_epoch FROM devices WHERE device_id=?1",
                params![device_id],
                |row| {
                    let hash: Vec<u8> = row.get(0)?;
                    let token_hash: [u8; 32] = hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?;
                    Ok(StoredDevice { device_id: device_id.to_owned(), token_hash, display_name: row.get(1)?, platform: row.get(2)?, identity_epoch: row.get::<_, i64>(3)? as u64 })
                },
            )
            .optional()
            .map_err(map_database_error)
    }

    pub fn list_devices(&self) -> Result<Vec<StoredDevice>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id, token_hash, display_name, platform, identity_epoch
                 FROM devices ORDER BY device_id ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                let hash: Vec<u8> = row.get(1)?;
                let token_hash: [u8; 32] =
                    hash.try_into().map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(StoredDevice {
                    device_id: row.get(0)?,
                    token_hash,
                    display_name: row.get(2)?,
                    platform: row.get(3)?,
                    identity_epoch: row.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| row.map_err(map_database_error)).collect()
    }

    pub fn remove_device(&self, device_id: &str) -> Result<(), StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("DELETE FROM devices WHERE device_id=?1", params![device_id])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn clear_devices(&self) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("DELETE FROM devices", [])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn set_identity_epoch(&self, epoch: u64) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .execute("INSERT INTO metadata(key, value) VALUES ('identity_epoch', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![epoch.to_string()])
            .map_err(map_database_error)?;
        Ok(())
    }

    pub fn identity_epoch(&self) -> Result<u64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let value = connection
            .query_row(
                "SELECT value FROM metadata WHERE key='identity_epoch'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_database_error)?
            .unwrap_or_else(|| "0".into());
        value.parse().map_err(|_| StorageError::Corrupt)
    }

    pub fn load_non_terminal_tasks(&self) -> Result<Vec<RemoteTaskSnapshot>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT snapshot_json FROM tasks WHERE state IN ('queued','starting','running','awaiting_input') ORDER BY updated_at_ms ASC")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(map_database_error)?;
        rows.map(|row| {
            let bytes = row.map_err(map_database_error)?;
            serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)
        })
        .collect()
    }

    pub fn load_tasks(&self) -> Result<Vec<StoredTask>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT snapshot_json, request_json FROM tasks
                 ORDER BY updated_at_ms ASC, task_id ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                let snapshot =
                    serde_json::from_slice::<RemoteTaskSnapshot>(&row.get::<_, Vec<u8>>(0)?)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?;
                let request = row
                    .get::<_, Option<Vec<u8>>>(1)?
                    .map(|bytes| {
                        serde_json::from_slice::<RemoteTaskCreateRequest>(&bytes)
                            .map_err(|_| rusqlite::Error::InvalidQuery)
                    })
                    .transpose()?;
                Ok(StoredTask { snapshot, request })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let task = row.map_err(map_database_error)?;
            if let Some(request) = &task.request {
                request.validate().map_err(|_| StorageError::Corrupt)?;
                if request.project_id != task.snapshot.project_id
                    || request.request_id != task.snapshot.request_id
                    || request.context_files != task.snapshot.context_files
                    || request.request_id.is_empty()
                {
                    return Err(StorageError::Corrupt);
                }
            }
            Ok(task)
        })
        .collect()
    }

    pub fn load_idempotency(&self, now_ms: u64) -> Result<Vec<IdempotencyRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT device_id, request_id, task_id, fingerprint, expires_at_ms
                 FROM idempotency
                 WHERE expires_at_ms > ?1
                   AND task_id IN (SELECT task_id FROM tasks)
                 ORDER BY expires_at_ms ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(params![now_ms as i64], |row| {
                let fingerprint = u64::from_ne_bytes(row.get::<_, i64>(3)?.to_ne_bytes());
                let expires_at_ms = u64::try_from(row.get::<_, i64>(4)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(IdempotencyRecord {
                    device_id: row.get(0)?,
                    request_id: row.get(1)?,
                    task_id: row.get(2)?,
                    fingerprint,
                    expires_at_ms,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let record = row.map_err(map_database_error)?;
            validate_key(&record.device_id)?;
            validate_key(&record.request_id)?;
            validate_key(&record.task_id)?;
            Ok(record)
        })
        .collect()
    }

    pub fn load_task(&self, task_id: &str) -> Result<Option<RemoteTaskSnapshot>, StorageError> {
        validate_key(task_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        connection
            .query_row(
                "SELECT snapshot_json FROM tasks WHERE task_id=?1",
                params![task_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(map_database_error)?
            .map(|bytes| serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt))
            .transpose()
    }

    pub fn load_events(
        &self,
        device_id: &str,
        after: Option<u64>,
    ) -> Result<Vec<StoredEvent>, StorageError> {
        validate_key(device_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare(
                "SELECT sequence, event_id, emitted_at_ms, event_json FROM events
                 WHERE device_id=?1 AND (?2 IS NULL OR sequence>?2) ORDER BY sequence ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map(params![device_id, after.map(|value| value as i64)], |row| {
                let sequence = row.get::<_, i64>(0)? as u64;
                let event_id = row.get::<_, String>(1)?;
                let emitted_at_ms = row.get::<_, i64>(2)? as u64;
                let payload = serde_json::from_slice::<RemoteEvent>(&row.get::<_, Vec<u8>>(3)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?;
                Ok(StoredEvent {
                    device_id: device_id.to_owned(),
                    sequence,
                    event_id,
                    emitted_at_ms,
                    payload,
                })
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let event = row.map_err(map_database_error)?;
            validate_event_metadata(&event)?;
            Ok(event)
        })
        .collect()
    }

    /// Marks work that was in flight when the desktop disappeared as a
    /// terminal, non-retryable restart failure.  The snapshot and its
    /// completion event are committed together so a new process cannot
    /// expose stale running work without an authoritative terminal record.
    pub fn recover_non_terminal_tasks(
        &self,
        emitted_at_ms: u64,
        emitted_at: &str,
    ) -> Result<Vec<RemoteTaskSnapshot>, StorageError> {
        let mut connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(map_database_error)?;
        let mut statement = transaction
            .prepare(
                "SELECT task_id, owner_device_id, snapshot_json FROM tasks
                 WHERE state IN ('queued','starting','running','awaiting_input')
                 ORDER BY updated_at_ms ASC",
            )
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(map_database_error)?;
        let rows = rows
            .map(|row| row.map_err(map_database_error))
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut recovered = Vec::new();
        for row in rows {
            let (task_id, owner_device_id, bytes) = row;
            let mut snapshot: RemoteTaskSnapshot =
                serde_json::from_slice(&bytes).map_err(|_| StorageError::Corrupt)?;
            if snapshot.owner_device_id != owner_device_id || snapshot.task_id != task_id {
                return Err(StorageError::Corrupt);
            }
            let error = RemoteTaskError {
                code: RemoteTaskFailureCode::DesktopRestarted,
                message: "desktop restarted while the task was active".to_owned(),
                retryable: false,
            };
            snapshot.state = RemoteTaskState::Failed;
            snapshot.updated_at = emitted_at.to_owned();
            snapshot.finished_at = Some(emitted_at.to_owned());
            snapshot.error = Some(error.clone());
            let next_sequence = transaction
                .query_row(
                    "SELECT COALESCE(MAX(sequence), 0) + 1 FROM events WHERE device_id=?1",
                    params![owner_device_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(map_database_error)? as u64;
            let event = RemoteEvent::TaskCompleted {
                base: RemoteEventBase {
                    event_id: format!("recovery-{task_id}-{emitted_at_ms}"),
                    emitted_at: emitted_at.to_owned(),
                    sequence: next_sequence,
                    device_id: owner_device_id.clone(),
                },
                task_id: task_id.clone(),
                state: RemoteTaskTerminalState::Failed,
                error: Some(error),
            };
            let snapshot_json =
                serde_json::to_vec(&snapshot).map_err(|_| StorageError::Database)?;
            let event_json = serde_json::to_vec(&event).map_err(|_| StorageError::Database)?;
            if snapshot_json.len() > MAX_SNAPSHOT_BYTES || event_json.len() > MAX_EVENT_BYTES {
                return Err(StorageError::PayloadTooLarge);
            }
            transaction
                .execute(
                    "UPDATE tasks SET state='failed', snapshot_json=?1, updated_at_ms=?2 WHERE task_id=?3",
                    params![snapshot_json, emitted_at_ms as i64, task_id],
                )
                .map_err(map_database_error)?;
            transaction
                .execute(
                    "INSERT INTO events(device_id, sequence, event_id, emitted_at_ms, event_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        owner_device_id,
                        next_sequence as i64,
                        format!("recovery-{task_id}-{emitted_at_ms}"),
                        emitted_at_ms as i64,
                        event_json
                    ],
                )
                .map_err(map_database_error)?;
            recovered.push(snapshot);
        }
        retain_locked(&transaction, self.limits, emitted_at_ms)?;
        transaction.commit().map_err(map_database_error)?;
        Ok(recovered)
    }

    pub fn counts(&self) -> Result<(usize, usize), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let tasks = connection
            .query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get::<_, i64>(0))
            .map_err(map_database_error)? as usize;
        let events = connection
            .query_row("SELECT COUNT(*) FROM events", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(map_database_error)? as usize;
        Ok((tasks, events))
    }

    pub fn event_cursors(&self) -> Result<Vec<(String, u64)>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Database)?;
        let mut statement = connection
            .prepare("SELECT device_id, MAX(sequence) FROM events GROUP BY device_id")
            .map_err(map_database_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
            })
            .map_err(map_database_error)?;
        rows.map(|row| {
            let (device_id, sequence) = row.map_err(map_database_error)?;
            validate_key(&device_id)?;
            Ok((device_id, sequence))
        })
        .collect()
    }
}

fn configure_and_migrate(connection: &mut Connection) -> Result<(), StorageError> {
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
        )
        .map_err(map_database_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(map_database_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS devices(device_id TEXT PRIMARY KEY NOT NULL, token_hash BLOB NOT NULL, display_name TEXT NOT NULL, platform TEXT NOT NULL, identity_epoch INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS tasks(task_id TEXT PRIMARY KEY NOT NULL, owner_device_id TEXT NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL, snapshot_json BLOB NOT NULL, request_json BLOB, updated_at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS idempotency(device_id TEXT NOT NULL, request_id TEXT NOT NULL, task_id TEXT NOT NULL, fingerprint INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, PRIMARY KEY(device_id, request_id));
             CREATE TABLE IF NOT EXISTS events(device_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT PRIMARY KEY NOT NULL, emitted_at_ms INTEGER NOT NULL, event_json BLOB NOT NULL, UNIQUE(device_id, sequence));
             CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at_ms);
             CREATE INDEX IF NOT EXISTS idx_events_emitted ON events(emitted_at_ms);
             INSERT INTO metadata(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO NOTHING;
             INSERT INTO metadata(key, value) VALUES ('identity_epoch', '0') ON CONFLICT(key) DO NOTHING;",
        )
        .map_err(map_database_error)?;
    let version: String = transaction
        .query_row(
            "SELECT value FROM metadata WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )
        .map_err(map_database_error)?;
    match version.parse::<i64>().ok() {
        Some(1) => {
            let has_request_column = transaction
                .prepare("PRAGMA table_info(tasks)")
                .map_err(map_database_error)?
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(map_database_error)?
                .any(|column| column.map(|name| name == "request_json").unwrap_or(false));
            if !has_request_column {
                transaction
                    .execute("ALTER TABLE tasks ADD COLUMN request_json BLOB", [])
                    .map_err(map_database_error)?;
            }
            transaction
                .execute(
                    "UPDATE metadata SET value=?1 WHERE key='schema_version'",
                    params![STORAGE_SCHEMA_VERSION.to_string()],
                )
                .map_err(map_database_error)?;
        }
        Some(version) if version == STORAGE_SCHEMA_VERSION => {}
        _ => return Err(StorageError::Corrupt),
    }
    transaction.commit().map_err(map_database_error)?;
    let quick_check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(map_database_error)?;
    if quick_check != "ok" {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn retain_locked(
    transaction: &rusqlite::Transaction<'_>,
    limits: StorageLimits,
    now: u64,
) -> Result<(), StorageError> {
    transaction
        .execute(
            "DELETE FROM events WHERE emitted_at_ms < ?1",
            params![now.saturating_sub(EVENT_RETENTION_MS) as i64],
        )
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM events WHERE rowid NOT IN (SELECT rowid FROM events ORDER BY emitted_at_ms DESC, rowid DESC LIMIT ?1)", params![limits.max_events as i64])
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM tasks WHERE updated_at_ms < ?1 AND state IN ('succeeded','failed','cancelled')", params![now.saturating_sub(TASK_RETENTION_MS) as i64])
        .map_err(map_database_error)?;
    transaction
        .execute("DELETE FROM tasks WHERE rowid NOT IN (SELECT rowid FROM tasks ORDER BY updated_at_ms DESC, rowid DESC LIMIT ?1) AND state IN ('succeeded','failed','cancelled')", params![limits.max_tasks as i64])
        .map_err(map_database_error)?;
    transaction
        .execute(
            "DELETE FROM idempotency
             WHERE expires_at_ms <= ?1
                OR task_id NOT IN (SELECT task_id FROM tasks)",
            params![now as i64],
        )
        .map_err(map_database_error)?;
    Ok(())
}

fn validate_key(value: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        Err(StorageError::InvalidKey)
    } else {
        Ok(())
    }
}

fn validate_event_metadata(event: &StoredEvent) -> Result<(), StorageError> {
    let (base_device_id, base_sequence, base_event_id) = match &event.payload {
        RemoteEvent::TaskCreated { base, .. }
        | RemoteEvent::TaskStateChanged { base, .. }
        | RemoteEvent::TaskOutputAppended { base, .. }
        | RemoteEvent::TaskCompleted { base, .. }
        | RemoteEvent::TaskChanges { base, .. }
        | RemoteEvent::InteractionRequested { base, .. }
        | RemoteEvent::InteractionResolved { base, .. }
        | RemoteEvent::InteractionExpired { base, .. }
        | RemoteEvent::SnapshotRequired { base, .. }
        | RemoteEvent::EventBackpressure { base, .. } => {
            (&base.device_id, base.sequence, &base.event_id)
        }
    };
    if base_device_id != &event.device_id
        || base_sequence != event.sequence
        || base_event_id != &event.event_id
    {
        return Err(StorageError::Corrupt);
    }
    Ok(())
}

fn map_database_error(error: rusqlite::Error) -> StorageError {
    match error {
        rusqlite::Error::SqliteFailure(error, _)
            if error.code == rusqlite::ErrorCode::DatabaseCorrupt
                || error.code == rusqlite::ErrorCode::NotADatabase =>
        {
            StorageError::Corrupt
        }
        _ => StorageError::Database,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_bounded() {
        assert_eq!(
            StorageLimits {
                max_tasks: 0,
                max_events: usize::MAX
            }
            .bounded()
            .max_tasks,
            MAX_TASKS
        );
    }
}
