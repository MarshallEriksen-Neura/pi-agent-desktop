use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use thiserror::Error;

const DEFAULT_MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(10);
static TEMP_NONCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Error)]
pub enum StateStoreError {
    #[error("state I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("state file is corrupt: {0}")]
    Corrupt(#[from] serde_json::Error),
    #[error("state payload exceeded {limit} bytes")]
    PayloadTooLarge { limit: usize },
    #[error("state write lock is poisoned")]
    LockPoisoned,
    #[error("state lock timed out after {timeout_ms} ms")]
    LockTimeout { timeout_ms: u128 },
    #[error("state update rejected: {0}")]
    UpdateRejected(String),
}

#[derive(Debug, Error)]
pub enum ProjectPathError {
    #[error("project root is unavailable: {0}")]
    RootUnavailable(#[source] std::io::Error),
    #[error("project path must be a non-empty relative path")]
    InvalidRelativePath,
    #[error("project path exceeded {limit} bytes")]
    PathTooLong { limit: usize },
    #[error("project target is unavailable: {0}")]
    TargetUnavailable(#[source] std::io::Error),
    #[error("project path escaped its authorized root")]
    EscapedRoot,
}

pub fn canonical_project_root(path: &Path) -> Result<PathBuf, ProjectPathError> {
    if !path.is_dir() {
        return Err(ProjectPathError::RootUnavailable(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "project root is not a directory",
        )));
    }
    fs::canonicalize(path).map_err(ProjectPathError::RootUnavailable)
}

pub fn resolve_existing_relative_path(
    canonical_root: &Path,
    relative: &Path,
    max_bytes: usize,
) -> Result<PathBuf, ProjectPathError> {
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(ProjectPathError::InvalidRelativePath);
    }
    if relative.as_os_str().to_string_lossy().len() > max_bytes {
        return Err(ProjectPathError::PathTooLong { limit: max_bytes });
    }
    let target = fs::canonicalize(canonical_root.join(relative))
        .map_err(ProjectPathError::TargetUnavailable)?;
    if !target.starts_with(canonical_root) {
        return Err(ProjectPathError::EscapedRoot);
    }
    Ok(target)
}

pub struct DurableJsonStore<T> {
    path: PathBuf,
    max_bytes: usize,
    write_lock: Mutex<()>,
    marker: std::marker::PhantomData<T>,
}

pub struct CrossProcessFileLock {
    _file: File,
}

impl CrossProcessFileLock {
    pub fn acquire(path: &Path, timeout: Duration) -> Result<Self, StateStoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            match try_acquire_file_lock(path) {
                Ok(file) => return Ok(Self { _file: file }),
                Err(error) if is_lock_contended(&error) && Instant::now() < deadline => {
                    thread::sleep(LOCK_RETRY_INTERVAL);
                }
                Err(error) if is_lock_contended(&error) => {
                    return Err(StateStoreError::LockTimeout {
                        timeout_ms: timeout.as_millis(),
                    });
                }
                Err(error) => return Err(error.into()),
            }
        }
    }
}

impl<T> DurableJsonStore<T>
where
    T: Serialize + DeserializeOwned,
{
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            max_bytes: DEFAULT_MAX_STATE_BYTES,
            write_lock: Mutex::new(()),
            marker: std::marker::PhantomData,
        }
    }

    pub fn with_max_bytes(mut self, max_bytes: usize) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    pub fn load(&self) -> Result<Option<T>, StateStoreError> {
        self.load_unlocked()
    }

    fn load_unlocked(&self) -> Result<Option<T>, StateStoreError> {
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let length = file.metadata()?.len() as usize;
        if length > self.max_bytes {
            return Err(StateStoreError::PayloadTooLarge {
                limit: self.max_bytes,
            });
        }
        let read_limit = self.max_bytes.saturating_add(1);
        let mut bytes = Vec::with_capacity(length.min(read_limit));
        file.take(read_limit as u64).read_to_end(&mut bytes)?;
        if bytes.len() > self.max_bytes {
            return Err(StateStoreError::PayloadTooLarge {
                limit: self.max_bytes,
            });
        }
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    pub fn store(&self, value: &T) -> Result<(), StateStoreError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StateStoreError::LockPoisoned)?;
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let _process_lock =
            CrossProcessFileLock::acquire(&lock_path(&self.path), DEFAULT_LOCK_TIMEOUT)?;
        self.store_unlocked(value)
    }

    pub fn update_locked<R>(
        &self,
        update: impl FnOnce(Option<T>) -> Result<(T, R), StateStoreError>,
    ) -> Result<R, StateStoreError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StateStoreError::LockPoisoned)?;
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let _process_lock =
            CrossProcessFileLock::acquire(&lock_path(&self.path), DEFAULT_LOCK_TIMEOUT)?;
        let (value, result) = update(self.load_unlocked()?)?;
        self.store_unlocked(&value)?;
        Ok(result)
    }

    fn store_unlocked(&self, value: &T) -> Result<(), StateStoreError> {
        let bytes = serde_json::to_vec_pretty(value)?;
        if bytes.len() > self.max_bytes {
            return Err(StateStoreError::PayloadTooLarge {
                limit: self.max_bytes,
            });
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        let temp = unique_temp_path(&self.path);
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            file.write_all(&bytes)?;
            file.flush()?;
            file.sync_all()?;
            atomic_replace(&temp, &self.path)?;
            sync_parent(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }
}

fn lock_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(".{file_name}.lock"))
}

#[cfg(windows)]
fn try_acquire_file_lock(path: &Path) -> Result<File, std::io::Error> {
    use std::os::windows::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).share_mode(0);
    options.open(path)
}

#[cfg(unix)]
fn try_acquire_file_lock(path: &Path) -> Result<File, std::io::Error> {
    use std::os::fd::AsRawFd;

    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)?;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(file)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn is_lock_contended(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(unix)]
fn is_lock_contended(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::EACCES | libc::EAGAIN))
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let nonce = TEMP_NONCE.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state.json");
    path.with_file_name(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce))
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    fs::rename(source, target)
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), std::io::Error> {
    File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_parent(_parent: &Path) -> Result<(), std::io::Error> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
    struct State {
        generation: u64,
        label: String,
    }

    #[test]
    fn corrupt_state_fails_closed_without_overwrite() {
        let directory = temp_dir("corrupt-state");
        let path = directory.join("desktop.json");
        fs::write(&path, b"{not-json").unwrap();
        let store = DurableJsonStore::<State>::new(&path);
        assert!(matches!(store.load(), Err(StateStoreError::Corrupt(_))));
        assert_eq!(fs::read(&path).unwrap(), b"{not-json");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_state_larger_than_the_read_limit() {
        let directory = temp_dir("oversized-state");
        let path = directory.join("desktop.json");
        fs::write(&path, br#"{"value":"too-large"}"#).unwrap();
        let store = DurableJsonStore::<serde_json::Value>::new(&path).with_max_bytes(8);
        assert!(matches!(
            store.load(),
            Err(StateStoreError::PayloadTooLarge { limit: 8 })
        ));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn state_writes_are_atomic_and_serialized() {
        let directory = temp_dir("atomic-state");
        let path = directory.join("desktop.json");
        let store = Arc::new(DurableJsonStore::<State>::new(&path));
        let mut workers = Vec::new();
        for generation in 0..8 {
            let store = Arc::clone(&store);
            workers.push(thread::spawn(move || {
                store
                    .store(&State {
                        generation,
                        label: format!("state-{generation}"),
                    })
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        let state = store.load().unwrap().unwrap();
        assert_eq!(state.label, format!("state-{}", state.generation));
        let leftovers = fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn independent_store_instances_preserve_concurrent_updates() {
        #[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
        struct SharedState {
            left: bool,
            right: bool,
        }

        let directory = temp_dir("cross-process-state-lock");
        let path = directory.join("desktop.json");
        DurableJsonStore::new(&path)
            .store(&SharedState::default())
            .unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut workers = Vec::new();
        for update_left in [true, false] {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            workers.push(thread::spawn(move || {
                let store = DurableJsonStore::<SharedState>::new(path);
                barrier.wait();
                store
                    .update_locked(|current| {
                        let mut state = current.unwrap_or_default();
                        if update_left {
                            state.left = true;
                        } else {
                            state.right = true;
                        }
                        thread::sleep(Duration::from_millis(25));
                        Ok((state, ()))
                    })
                    .unwrap();
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let state = DurableJsonStore::<SharedState>::new(&path)
            .load()
            .unwrap()
            .unwrap();
        assert!(state.left && state.right);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unsafe_relative_paths_and_symlink_escape() {
        let directory = temp_dir("path-policy");
        let root = directory.join("project");
        let outside = directory.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("safe.txt"), b"safe").unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let canonical_root = canonical_project_root(&root).unwrap();
        assert!(
            resolve_existing_relative_path(&canonical_root, Path::new("safe.txt"), 512).is_ok()
        );
        for unsafe_path in ["", "../outside/secret.txt", ".", "C:\\Windows\\win.ini"] {
            assert!(
                resolve_existing_relative_path(&canonical_root, Path::new(unsafe_path), 512)
                    .is_err()
            );
        }

        #[cfg(windows)]
        {
            use std::os::windows::fs::symlink_file;
            let link = root.join("escape.txt");
            if symlink_file(outside.join("secret.txt"), &link).is_ok() {
                assert!(matches!(
                    resolve_existing_relative_path(&canonical_root, Path::new("escape.txt"), 512),
                    Err(ProjectPathError::EscapedRoot)
                ));
            }
        }
        fs::remove_dir_all(directory).unwrap();
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("pi-backend-{label}-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }
}
