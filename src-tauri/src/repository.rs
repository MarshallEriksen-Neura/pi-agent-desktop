use crate::pi_bridge::PiProc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

const METADATA_MAX_BYTES: usize = 64 * 1024;
const STATUS_MAX_BYTES: usize = 8 * 1024 * 1024;
const DIFF_MAX_BYTES: usize = 4 * 1024 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatusReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    porcelain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryDiffReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryMutationReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    porcelain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository_operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    applied: bool,
}

fn read_bounded<R: Read>(mut reader: R, max_bytes: usize) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::with_capacity(max_bytes.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = max_bytes.saturating_sub(kept.len());
        kept.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(kept)
}

fn run_git(root: &str, args: &[&str], max_bytes: usize) -> Result<Output, String> {
    run_git_with_index(root, args, max_bytes, None)
}

fn run_git_with_index(
    root: &str,
    args: &[&str],
    max_bytes: usize,
    index_path: Option<&Path>,
) -> Result<Output, String> {
    let mut command = Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key
            .to_string_lossy()
            .to_ascii_uppercase()
            .starts_with("GIT_")
        {
            command.env_remove(key);
        }
    }
    if let Some(index_path) = index_path {
        command.env("GIT_INDEX_FILE", index_path);
    }
    command
        .arg("-C")
        .arg(root)
        .arg("-c")
        .arg("core.fsmonitor=false")
        .arg("-c")
        .arg("core.untrackedCache=false")
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "gitUnavailable: Git executable was not found".to_owned()
        } else {
            format!("gitUnavailable: cannot start Git: {error}")
        }
    })?;
    let stdout = child.stdout.take().ok_or("Git stdout was not captured")?;
    let stderr = child.stderr.take().ok_or("Git stderr was not captured")?;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, max_bytes));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, METADATA_MAX_BYTES));
    let started = Instant::now();
    let status: ExitStatus = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("wait for Git: {error}"))?
        {
            break status;
        }
        if started.elapsed() >= GIT_TIMEOUT {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(format!(
                "gitUnavailable: Git timed out after {}s",
                GIT_TIMEOUT.as_secs()
            ));
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "read Git stdout thread panicked".to_owned())?
        .map_err(|error| format!("read Git stdout: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "read Git stderr thread panicked".to_owned())?
        .map_err(|error| format!("read Git stderr: {error}"))?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn empty_hooks_dir() -> Result<PathBuf, String> {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for nonce in 0..16_u8 {
        let path = std::env::temp_dir().join(format!(
            "pi-desktop-hooks-{}-{seed}-{nonce}",
            std::process::id()
        ));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("create isolated Git hooks directory: {error}")),
        }
    }
    Err("could not allocate an isolated Git hooks directory".to_owned())
}

fn unavailable(reason: &str, detail: impl Into<String>) -> RepositoryStatusReply {
    RepositoryStatusReply {
        ok: false,
        repo_root: None,
        porcelain: None,
        generation: None,
        operation: None,
        reason: Some(reason.to_owned()),
        detail: Some(detail.into()),
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

fn discover_repo_root(workspace_root: &str) -> Result<Option<String>, String> {
    let output = run_git(
        workspace_root,
        &["rev-parse", "--show-toplevel"],
        METADATA_MAX_BYTES,
    )?;
    if !output.status.success() {
        let detail = stderr(&output);
        if detail.contains("not a git repository") {
            return Ok(None);
        }
        return Err(format!(
            "gitUnavailable: {}",
            if detail.is_empty() {
                "Git could not inspect this workspace"
            } else {
                &detail
            }
        ));
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if root.is_empty() {
        return Err("gitUnavailable: Git returned an empty repository root".into());
    }
    Ok(Some(root))
}

fn git_dir(repo_root: &str) -> Option<PathBuf> {
    let output = run_git(
        repo_root,
        &["rev-parse", "--absolute-git-dir"],
        METADATA_MAX_BYTES,
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

struct RepositoryIndexLock {
    path: PathBuf,
    file: Option<fs::File>,
}

impl RepositoryIndexLock {
    fn acquire(repo_root: &str) -> Result<Self, String> {
        let directory = git_dir(repo_root).ok_or("gitUnavailable: cannot locate Git directory")?;
        let path = directory.join("index.lock");
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| {
                format!("indexLocked: cannot acquire `{}`: {error}", path.display())
            })?;
        Ok(Self {
            path,
            file: Some(file),
        })
    }

    fn install(mut self, source: &Path) -> Result<(), String> {
        let bytes = fs::read(source)
            .map_err(|error| format!("gitUnavailable: read temporary index: {error}"))?;
        let mut file = self
            .file
            .take()
            .ok_or("gitUnavailable: repository index lock was already released")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("gitUnavailable: write repository index lock: {error}"))?;
        drop(file);
        let destination = self
            .path
            .parent()
            .ok_or("gitUnavailable: repository index has no parent")?
            .join("index");
        fs::rename(&self.path, &destination)
            .map_err(|error| format!("gitUnavailable: install repository index: {error}"))?;
        Ok(())
    }
}

impl Drop for RepositoryIndexLock {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}

fn temporary_index(repo_root: &str) -> Result<(tempfile::TempDir, PathBuf), String> {
    let directory = git_dir(repo_root).ok_or("gitUnavailable: cannot locate Git directory")?;
    let temporary = tempfile::Builder::new()
        .prefix("pi-desktop-index-")
        .tempdir_in(directory)
        .map_err(|error| format!("gitUnavailable: create temporary index: {error}"))?;
    let path = temporary.path().join("index");
    let live = git_dir(repo_root)
        .ok_or("gitUnavailable: cannot locate Git directory")?
        .join("index");
    if live.exists() {
        fs::copy(&live, &path)
            .map_err(|error| format!("gitUnavailable: snapshot repository index: {error}"))?;
    }
    Ok((temporary, path))
}

fn repository_operation(repo_root: &str) -> Option<String> {
    let git_dir = git_dir(repo_root)?;
    let markers = [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherryPick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
    ];
    markers.iter().find_map(|(marker, operation)| {
        git_dir
            .join(marker)
            .exists()
            .then(|| (*operation).to_owned())
    })
}

fn normalized(path: &str) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

fn same_repo(actual: &str, claimed: &str) -> bool {
    match (normalized(actual), normalized(claimed)) {
        (Some(actual), Some(claimed)) => actual == claimed,
        _ => actual == claimed,
    }
}

fn valid_repository_path(path: &str) -> bool {
    if path.is_empty() || Path::new(path).is_absolute() || path.contains('\0') {
        return false;
    }
    !Path::new(path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn ensure_safe_repository_config(repo_root: &str) -> Result<(), String> {
    let output = run_git(
        repo_root,
        &[
            "config",
            "--local",
            "--get-regexp",
            r"^filter\..*\.(clean|process)$",
        ],
        METADATA_MAX_BYTES,
    )?;
    if output.status.success() && !output.stdout.is_empty() {
        return Err(
            "unsafeRepositoryConfiguration: executable Git clean filters are not supported"
                .to_owned(),
        );
    }
    if output.status.code() != Some(1) {
        return Err(format!(
            "gitUnavailable: cannot inspect repository filters: {}",
            stderr(&output)
        ));
    }
    Ok(())
}

fn status_porcelain(repo_root: &str) -> Result<Vec<u8>, String> {
    ensure_safe_repository_config(repo_root)?;
    let output = run_git(
        repo_root,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        STATUS_MAX_BYTES + 1,
    )?;
    if !output.status.success() {
        return Err(format!("gitUnavailable: {}", stderr(&output)));
    }
    if output.stdout.len() > STATUS_MAX_BYTES {
        return Err("gitUnavailable: Repository status exceeded its safety limit.".into());
    }
    Ok(output.stdout)
}

fn worktree_paths(porcelain: &str) -> Vec<String> {
    let records = porcelain.split('\0').collect::<Vec<_>>();
    let mut paths = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.starts_with("1 ") {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if fields.get(1).and_then(|xy| xy.as_bytes().get(1)).copied() != Some(b'.') {
                if let Some(path) = fields.get(8) {
                    paths.push((*path).to_owned());
                }
            }
        } else if record.starts_with("2 ") {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            if fields.get(1).and_then(|xy| xy.as_bytes().get(1)).copied() != Some(b'.') {
                if let Some(path) = fields.get(9) {
                    paths.push((*path).to_owned());
                }
            }
            index += 1; // porcelain v2 stores the original rename path next.
        } else if record.starts_with("u ") {
            if let Some(path) = record.splitn(11, ' ').nth(10) {
                paths.push(path.to_owned());
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            paths.push(path.to_owned());
        }
        index += 1;
    }
    paths.sort();
    paths.dedup();
    paths
}

#[derive(Debug)]
struct MutationEntry {
    path: String,
    original_path: Option<String>,
    index_changed: bool,
    worktree_changed: bool,
}

fn mutation_entries(porcelain: &str) -> Vec<MutationEntry> {
    let records = porcelain.split('\0').collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = records[index];
        if record.starts_with("1 ") {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if let (Some(xy), Some(path)) = (fields.get(1), fields.get(8)) {
                let bytes = xy.as_bytes();
                entries.push(MutationEntry {
                    path: (*path).to_owned(),
                    original_path: None,
                    index_changed: bytes.first().copied() != Some(b'.'),
                    worktree_changed: bytes.get(1).copied() != Some(b'.'),
                });
            }
        } else if record.starts_with("2 ") {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            if let (Some(xy), Some(path)) = (fields.get(1), fields.get(9)) {
                let bytes = xy.as_bytes();
                entries.push(MutationEntry {
                    path: (*path).to_owned(),
                    original_path: records.get(index + 1).map(|value| (*value).to_owned()),
                    index_changed: bytes.first().copied() != Some(b'.'),
                    worktree_changed: bytes.get(1).copied() != Some(b'.'),
                });
            }
            index += 1;
        } else if record.starts_with("u ") {
            if let Some(path) = record.splitn(11, ' ').nth(10) {
                entries.push(MutationEntry {
                    path: path.to_owned(),
                    original_path: None,
                    index_changed: true,
                    worktree_changed: true,
                });
            }
        } else if let Some(path) = record.strip_prefix("? ") {
            entries.push(MutationEntry {
                path: path.to_owned(),
                original_path: None,
                index_changed: false,
                worktree_changed: true,
            });
        }
        index += 1;
    }
    entries
}

fn validated_mutation_paths(
    porcelain: &str,
    operation: &str,
    path: &str,
    original_path: Option<&str>,
) -> Option<Vec<String>> {
    let entry = mutation_entries(porcelain)
        .into_iter()
        .find(|entry| entry.path == path)?;
    let allowed = match operation {
        "stage" => entry.worktree_changed,
        "unstage" => entry.index_changed,
        _ => false,
    };
    if !allowed || entry.original_path.as_deref() != original_path {
        return None;
    }
    let mut paths = vec![entry.path];
    if let Some(original) = entry.original_path {
        paths.push(original);
    }
    Some(paths)
}

fn update_hash_segment(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn worktree_fingerprint(repo_root: &str, porcelain: &str) -> Result<String, String> {
    worktree_fingerprint_inner(repo_root, porcelain, 0)
}

fn worktree_fingerprint_inner(
    repo_root: &str,
    porcelain: &str,
    depth: usize,
) -> Result<String, String> {
    if depth > 8 {
        return Err("submodule nesting exceeded the generation safety limit".to_owned());
    }
    let mut hasher = Sha256::new();
    let mut total_bytes = 0_u64;
    for relative in worktree_paths(porcelain) {
        update_hash_segment(&mut hasher, relative.as_bytes());
        let absolute = Path::new(repo_root).join(&relative);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                update_hash_segment(&mut hasher, b"missing");
                continue;
            }
            Err(error) => return Err(format!("inspect `{relative}` for generation: {error}")),
        };
        if metadata.file_type().is_symlink() {
            update_hash_segment(&mut hasher, b"symlink");
            let target = fs::read_link(&absolute)
                .map_err(|error| format!("read symlink `{relative}` for generation: {error}"))?;
            let value = target.to_string_lossy();
            total_bytes = total_bytes.saturating_add(value.len() as u64);
            update_hash_segment(&mut hasher, value.as_bytes());
        } else if metadata.is_file() {
            update_hash_segment(&mut hasher, b"file");
            let mut file = fs::File::open(&absolute)
                .map_err(|error| format!("open `{relative}` for generation: {error}"))?;
            let mut file_hasher = Sha256::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| format!("read `{relative}` for generation: {error}"))?;
                if read == 0 {
                    break;
                }
                total_bytes = total_bytes.saturating_add(read as u64);
                file_hasher.update(&buffer[..read]);
            }
            update_hash_segment(&mut hasher, &file_hasher.finalize());
        } else if metadata.is_dir() {
            // A changed directory is normally a submodule (untracked-files=all emits
            // ordinary files). Include its HEAD and nested status/content fingerprint.
            update_hash_segment(&mut hasher, b"directory");
            let head = run_git(
                absolute.to_string_lossy().as_ref(),
                &["rev-parse", "HEAD"],
                METADATA_MAX_BYTES,
            )?;
            if !head.status.success() {
                return Err(format!("inspect submodule `{relative}`: {}", stderr(&head)));
            }
            let nested = status_porcelain(absolute.to_string_lossy().as_ref())?;
            total_bytes = total_bytes.saturating_add(nested.len() as u64);
            update_hash_segment(&mut hasher, &head.stdout);
            let nested_fingerprint = worktree_fingerprint_inner(
                absolute.to_string_lossy().as_ref(),
                &String::from_utf8_lossy(&nested),
                depth + 1,
            )?;
            update_hash_segment(&mut hasher, nested_fingerprint.as_bytes());
            update_hash_segment(&mut hasher, &nested);
        } else {
            update_hash_segment(&mut hasher, b"other");
            update_hash_segment(&mut hasher, metadata.len().to_string().as_bytes());
        }
    }
    Ok(format!("content-{total_bytes:x}-{:x}", hasher.finalize()))
}

fn repository_generation(
    repo_root: &str,
    operation: Option<&str>,
    porcelain: &str,
    content_fingerprint: &str,
) -> String {
    let mut hasher = Sha256::new();
    for segment in [
        repo_root.as_bytes(),
        operation.unwrap_or("").as_bytes(),
        porcelain.as_bytes(),
        content_fingerprint.as_bytes(),
    ] {
        update_hash_segment(&mut hasher, segment);
    }
    format!("repo-sha256-{:x}", hasher.finalize())
}

fn mutation_failure(
    reason: &str,
    detail: impl Into<String>,
    applied: bool,
) -> RepositoryMutationReply {
    RepositoryMutationReply {
        ok: false,
        repo_root: None,
        porcelain: None,
        generation: None,
        repository_operation: None,
        commit_oid: None,
        reason: Some(reason.to_owned()),
        detail: Some(detail.into()),
        applied,
    }
}

fn classify_mutation_failure(detail: &str) -> &'static str {
    if detail.starts_with("unsafeRepositoryConfiguration:") {
        "unsafeRepositoryConfiguration"
    } else if detail.contains("index.lock") || detail.contains("Unable to create") {
        "indexLocked"
    } else {
        "gitUnavailable"
    }
}
#[cfg(test)]
type MutationTestHook = Box<dyn FnMut(&str, &str) + Send>;

#[cfg(test)]
static MUTATION_TEST_HOOK: std::sync::OnceLock<std::sync::Mutex<Option<MutationTestHook>>> =
    std::sync::OnceLock::new();

#[cfg(test)]
fn mutation_checkpoint(name: &str, repo_root: &str) {
    let hook = MUTATION_TEST_HOOK.get_or_init(|| std::sync::Mutex::new(None));
    if let Some(callback) = hook.lock().expect("mutation test hook lock").as_mut() {
        callback(name, repo_root);
    }
}

#[cfg(not(test))]
fn mutation_checkpoint(_name: &str, _repo_root: &str) {}

#[cfg(test)]
fn set_mutation_test_hook(hook: Option<MutationTestHook>) {
    *MUTATION_TEST_HOOK
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .expect("mutation test hook lock") = hook;
}

#[tauri::command]
pub async fn repository_status(workspace_root: String) -> Result<RepositoryStatusReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo_root = match discover_repo_root(&workspace_root) {
            Ok(Some(root)) => root,
            Ok(None) => {
                return Ok(unavailable(
                    "notRepository",
                    "The workspace is not inside a Git repository.",
                ))
            }
            Err(error) => return Ok(unavailable("gitUnavailable", error)),
        };
        let porcelain = match status_porcelain(&repo_root) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(error) => {
                let reason = if error.starts_with("unsafeRepositoryConfiguration:") {
                    "unsafeRepositoryConfiguration"
                } else {
                    "gitUnavailable"
                };
                return Ok(unavailable(reason, error));
            }
        };
        let operation = repository_operation(&repo_root);
        let content_fingerprint = match worktree_fingerprint(&repo_root, &porcelain) {
            Ok(value) => value,
            Err(error) => return Ok(unavailable("gitUnavailable", error)),
        };
        let generation = repository_generation(
            &repo_root,
            operation.as_deref(),
            &porcelain,
            &content_fingerprint,
        );
        Ok(RepositoryStatusReply {
            ok: true,
            repo_root: Some(repo_root),
            porcelain: Some(porcelain),
            generation: Some(generation),
            operation,
            reason: None,
            detail: None,
        })
    })
    .await
    .map_err(|error| format!("repository status task failed: {error}"))?
}

#[tauri::command]
pub async fn repository_diff(
    workspace_root: String,
    repo_root: String,
    path: String,
    diff_kind: String,
) -> Result<RepositoryDiffReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_repository_path(&path) {
            return Err("repository path must be relative and remain inside the repository".into());
        }
        if diff_kind != "staged" && diff_kind != "unstaged" {
            return Err("repository diff kind must be staged or unstaged".into());
        }
        let actual_root = discover_repo_root(&workspace_root)?
            .ok_or("repository identity changed; refresh status and try again")?;
        if !same_repo(&actual_root, &repo_root) {
            return Err("repository identity changed; refresh status and try again".into());
        }
        ensure_safe_repository_config(&actual_root)?;
        let mut args = vec![
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ];
        if diff_kind == "staged" {
            args.push("--cached");
        }
        args.push("--");
        args.push(path.as_str());
        let output = run_git(&actual_root, &args, DIFF_MAX_BYTES + 1)?;
        if !output.status.success() {
            return Ok(RepositoryDiffReply {
                ok: false,
                text: None,
                truncated: false,
                reason: Some("gitUnavailable".into()),
                detail: Some(stderr(&output)),
            });
        }
        let truncated = output.stdout.len() > DIFF_MAX_BYTES;
        let bytes = if truncated {
            &output.stdout[..DIFF_MAX_BYTES]
        } else {
            &output.stdout
        };
        Ok(RepositoryDiffReply {
            ok: true,
            text: Some(String::from_utf8_lossy(bytes).into_owned()),
            truncated,
            reason: None,
            detail: None,
        })
    })
    .await
    .map_err(|error| format!("repository diff task failed: {error}"))?
}

#[tauri::command]
pub async fn repository_mutate(
    state: State<'_, PiProc>,
    target_id: String,
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    path: Option<String>,
    original_path: Option<String>,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    let _write_guard = match state.begin_repository_write(&target_id, &workspace_root) {
        Ok(guard) => guard,
        Err(detail) => return Ok(mutation_failure("piBusy", detail, false)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repository_mutate_blocking(
            workspace_root,
            repo_root,
            generation,
            operation,
            path,
            original_path,
            message,
        )
    })
    .await
    .map_err(|error| format!("repository mutation task failed: {error}"))?
}

fn repository_mutate_blocking(
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    path: Option<String>,
    original_path: Option<String>,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if !matches!(operation.as_str(), "stage" | "unstage" | "commit") {
        return Ok(mutation_failure(
            "invalidRequest",
            "Unsupported repository mutation.",
            false,
        ));
    }
    if let Some(value) = path.as_deref() {
        if !valid_repository_path(value) {
            return Ok(mutation_failure(
                "invalidRequest",
                "Repository path must be relative and remain inside the repository.",
                false,
            ));
        }
    }
    if let Some(value) = original_path.as_deref() {
        if !valid_repository_path(value) {
            return Ok(mutation_failure(
                "invalidRequest",
                "Original repository path must remain inside the repository.",
                false,
            ));
        }
    }
    let actual_root = match discover_repo_root(&workspace_root) {
        Ok(Some(root)) => root,
        Ok(None) => {
            return Ok(mutation_failure(
                "repositoryChanged",
                "The workspace is no longer in a Git repository.",
                false,
            ))
        }
        Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
    };
    if !same_repo(&actual_root, &repo_root) {
        return Ok(mutation_failure(
            "repositoryChanged",
            "Repository identity changed; refresh status and try again.",
            false,
        ));
    }
    let before_operation = repository_operation(&actual_root);
    let before_bytes = match status_porcelain(&actual_root) {
        Ok(value) => value,
        Err(error) => {
            return Ok(mutation_failure(
                classify_mutation_failure(&error),
                error,
                false,
            ))
        }
    };
    let before = String::from_utf8_lossy(&before_bytes).into_owned();
    let content_fingerprint = match worktree_fingerprint(&actual_root, &before) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
    };
    if repository_generation(
        &actual_root,
        before_operation.as_deref(),
        &before,
        &content_fingerprint,
    ) != generation
    {
        return Ok(mutation_failure(
            "staleGeneration",
            "Repository files or index changed; refresh and review before writing.",
            false,
        ));
    }
    if before.split('\0').any(|record| record.starts_with("u ")) {
        return Ok(mutation_failure(
            "conflictsPresent",
            "Resolve repository conflicts before staging or committing.",
            false,
        ));
    }
    if before_operation.is_some() {
        return Ok(mutation_failure(
            "operationInProgress",
            "Finish the current Git operation before staging or committing.",
            false,
        ));
    }

    let validated_paths = if operation == "stage" || operation == "unstage" {
        let Some(path) = path.as_deref() else {
            return Ok(mutation_failure(
                "invalidRequest",
                "Stage and unstage require a repository file from the reviewed snapshot.",
                false,
            ));
        };
        match validated_mutation_paths(&before, &operation, path, original_path.as_deref()) {
            Some(paths) => Some(paths),
            None => {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Repository path did not identify exactly one reviewed file.",
                    false,
                ))
            }
        }
    } else {
        if path.is_some() || original_path.is_some() {
            return Ok(mutation_failure(
                "invalidRequest",
                "Commit does not accept repository paths.",
                false,
            ));
        }
        None
    };
    mutation_checkpoint("before-index-lock", &actual_root);

    let lock = match RepositoryIndexLock::acquire(&actual_root) {
        Ok(value) => value,
        Err(error) => {
            return Ok(mutation_failure(
                classify_mutation_failure(&error),
                error,
                false,
            ))
        }
    };
    let locked_operation = repository_operation(&actual_root);
    let locked_bytes = match status_porcelain(&actual_root) {
        Ok(value) => value,
        Err(error) => {
            return Ok(mutation_failure(
                classify_mutation_failure(&error),
                error,
                false,
            ))
        }
    };
    let locked_porcelain = String::from_utf8_lossy(&locked_bytes).into_owned();
    let locked_fingerprint = match worktree_fingerprint(&actual_root, &locked_porcelain) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
    };
    if locked_operation != before_operation
        || repository_generation(
            &actual_root,
            locked_operation.as_deref(),
            &locked_porcelain,
            &locked_fingerprint,
        ) != generation
    {
        return Ok(mutation_failure(
            "staleGeneration",
            "Repository files or index changed before the write lock was acquired.",
            false,
        ));
    }
    mutation_checkpoint("after-index-lock", &actual_root);
    let mut expected_commit_tree: Option<String> = None;
    let mut index_lock = Some(lock);
    let (output, temporary_index_dir) = match operation.as_str() {
        "stage" => {
            let paths = validated_paths
                .as_ref()
                .expect("stage paths were validated");
            let (directory, temporary_index) = match temporary_index(&actual_root) {
                Ok(value) => value,
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let mut args = vec!["--literal-pathspecs", "add", "--all", "--"];
            for path in paths {
                args.push(path.as_str());
            }
            (
                run_git_with_index(
                    &actual_root,
                    &args,
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                ),
                Some(directory),
            )
        }
        "unstage" => {
            let paths = validated_paths
                .as_ref()
                .expect("unstage paths were validated");
            let (directory, temporary_index) = match temporary_index(&actual_root) {
                Ok(value) => value,
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let has_head = run_git(
                &actual_root,
                &["rev-parse", "--verify", "HEAD"],
                METADATA_MAX_BYTES,
            )
            .map(|value| value.status.success())
            .unwrap_or(false);
            let mut args = if has_head {
                vec!["--literal-pathspecs", "reset", "-q", "HEAD", "--"]
            } else {
                vec![
                    "--literal-pathspecs",
                    "rm",
                    "--cached",
                    "-q",
                    "--ignore-unmatch",
                    "--",
                ]
            };
            for path in paths {
                args.push(path.as_str());
            }
            (
                run_git_with_index(
                    &actual_root,
                    &args,
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                ),
                Some(directory),
            )
        }
        "commit" => {
            let message = message.as_deref().map(str::trim).unwrap_or("");
            if message.is_empty() {
                return Ok(mutation_failure(
                    "emptyMessage",
                    "Enter a commit message.",
                    false,
                ));
            }
            if message.len() > 4096 || message.contains('\0') {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Commit message exceeds the 4096-byte safety limit.",
                    false,
                ));
            }
            let (directory, temporary_index) = match temporary_index(&actual_root) {
                Ok(value) => value,
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let staged = run_git_with_index(
                &actual_root,
                &["diff", "--cached", "--quiet", "--exit-code"],
                METADATA_MAX_BYTES,
                Some(&temporary_index),
            );
            match staged {
                Ok(value) if value.status.code() == Some(0) => {
                    return Ok(mutation_failure(
                        "nothingStaged",
                        "There are no explicitly staged changes to commit.",
                        false,
                    ));
                }
                Ok(value) if value.status.code() == Some(1) => {}
                Ok(value) => return Ok(mutation_failure("gitUnavailable", stderr(&value), false)),
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            }
            let tree = match run_git_with_index(
                &actual_root,
                &["write-tree"],
                METADATA_MAX_BYTES,
                Some(&temporary_index),
            ) {
                Ok(value) if value.status.success() => {
                    String::from_utf8_lossy(&value.stdout).trim().to_owned()
                }
                Ok(value) => {
                    return Ok(mutation_failure("gitUnavailable", stderr(&value), false));
                }
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            mutation_checkpoint("after-write-tree", &actual_root);
            let expected_old_head = run_git(
                &actual_root,
                &["rev-parse", "--verify", "HEAD"],
                METADATA_MAX_BYTES,
            )
            .ok()
            .filter(|value| value.status.success())
            .map(|value| String::from_utf8_lossy(&value.stdout).trim().to_owned());
            let hooks_dir = match empty_hooks_dir() {
                Ok(path) => path,
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let hooks_path = hooks_dir.to_string_lossy().into_owned();
            let hooks_config = format!("core.hooksPath={hooks_path}");
            let mut commit_args = vec![
                "-c",
                "commit.gpgSign=false",
                "-c",
                hooks_config.as_str(),
                "commit-tree",
                &tree,
            ];
            if let Some(parent) = expected_old_head.as_deref() {
                commit_args.extend(["-p", parent]);
            }
            commit_args.extend(["-m", message]);
            let commit_tree = run_git_with_index(
                &actual_root,
                &commit_args,
                METADATA_MAX_BYTES,
                Some(&temporary_index),
            );
            let _ = fs::remove_dir(&hooks_dir);
            let commit_tree = match commit_tree {
                Ok(value) if value.status.success() => value,
                Ok(value) => return Ok(mutation_failure("gitUnavailable", stderr(&value), false)),
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let commit_oid = String::from_utf8_lossy(&commit_tree.stdout)
                .trim()
                .to_owned();
            let symbolic = run_git(
                &actual_root,
                &["symbolic-ref", "-q", "HEAD"],
                METADATA_MAX_BYTES,
            )
            .ok()
            .filter(|value| value.status.success())
            .map(|value| String::from_utf8_lossy(&value.stdout).trim().to_owned());
            let reference = symbolic.as_deref().unwrap_or("HEAD");
            let expected = expected_old_head
                .clone()
                .unwrap_or_else(|| "0".repeat(commit_oid.len()));
            let update = run_git(
                &actual_root,
                &["update-ref", reference, &commit_oid, &expected],
                METADATA_MAX_BYTES,
            );
            expected_commit_tree = Some(tree);
            (update, Some(directory))
        }
        _ => unreachable!(),
    };
    let output = match output {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
    };
    if !output.status.success() {
        let detail = stderr(&output);
        return Ok(mutation_failure(
            classify_mutation_failure(&detail),
            detail,
            false,
        ));
    }
    if operation == "stage" || operation == "unstage" {
        let temporary_index = temporary_index_dir
            .as_ref()
            .expect("temporary index directory exists")
            .path()
            .join("index");
        let lock = index_lock.take().expect("repository index lock exists");
        if let Err(error) = lock.install(&temporary_index) {
            return Ok(mutation_failure(
                classify_mutation_failure(&error),
                error,
                false,
            ));
        }
    } else {
        drop(index_lock.take());
    }
    if let Some(expected_tree) = expected_commit_tree {
        let committed_tree = run_git(
            &actual_root,
            &["show", "-s", "--format=%T", "HEAD"],
            METADATA_MAX_BYTES,
        );
        match committed_tree {
            Ok(value)
                if value.status.success()
                    && String::from_utf8_lossy(&value.stdout).trim() == expected_tree => {}
            Ok(value) => {
                let detail = stderr(&value);
                return Ok(mutation_failure(
                    "refreshFailed",
                    if detail.is_empty() {
                        "Committed tree did not match the reviewed index.".to_owned()
                    } else {
                        detail
                    },
                    true,
                ));
            }
            Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
        }
    }

    let after_operation = repository_operation(&actual_root);
    let after_bytes = match status_porcelain(&actual_root) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
    let after = String::from_utf8_lossy(&after_bytes).into_owned();
    let content_fingerprint = match worktree_fingerprint(&actual_root, &after) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
    let after_generation = repository_generation(
        &actual_root,
        after_operation.as_deref(),
        &after,
        &content_fingerprint,
    );
    let commit_oid = if operation == "commit" {
        run_git(&actual_root, &["rev-parse", "HEAD"], METADATA_MAX_BYTES)
            .ok()
            .filter(|value| value.status.success())
            .map(|value| String::from_utf8_lossy(&value.stdout).trim().to_owned())
    } else {
        None
    };
    Ok(RepositoryMutationReply {
        ok: true,
        repo_root: Some(actual_root),
        porcelain: Some(after),
        generation: Some(after_generation),
        repository_operation: after_operation,
        commit_oid,
        reason: None,
        detail: None,
        applied: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        discover_repo_root, repository_generation, repository_mutate_blocking,
        repository_operation, set_mutation_test_hook, status_porcelain, worktree_fingerprint,
    };
    use std::fs;
    use std::process::Command;

    fn git(root: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("create repository fixture");
        git(directory.path(), &["init", "-q"]);
        git(
            directory.path(),
            &["config", "user.email", "test@example.com"],
        );
        git(
            directory.path(),
            &["config", "user.name", "Repository Test"],
        );
        directory
    }

    fn root_and_generation(root: &std::path::Path) -> (String, String) {
        let workspace = root.to_string_lossy();
        let actual_root = discover_repo_root(&workspace)
            .expect("discover repository")
            .expect("repository root");
        let porcelain = String::from_utf8(status_porcelain(&actual_root).expect("status"))
            .expect("utf8 status");
        let operation = repository_operation(&actual_root);
        let fingerprint =
            worktree_fingerprint(&actual_root, &porcelain).expect("content fingerprint");
        let generation =
            repository_generation(&actual_root, operation.as_deref(), &porcelain, &fingerprint);
        (actual_root, generation)
    }

    fn git_stdout(root: &std::path::Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn repository_generation_matches_launcher_sha256_contract() {
        assert_eq!(
            repository_generation(
                "/repo",
                Some("rebase"),
                "# branch.head main\0",
                "content-4-abc",
            ),
            "repo-sha256-1de4e41023ed3d777ba55dc8c9dba34f3c65467d95c2a44c665f5ce060c9e5fc"
        );
    }

    #[test]
    fn worktree_fingerprint_changes_when_porcelain_does_not() {
        let directory = tempfile::tempdir().expect("create repository fixture");
        git(directory.path(), &["init", "-q"]);
        git(
            directory.path(),
            &["config", "user.email", "test@example.com"],
        );
        git(
            directory.path(),
            &["config", "user.name", "Repository Test"],
        );
        fs::write(directory.path().join("file.txt"), "base\n").expect("write fixture");
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        fs::write(directory.path().join("file.txt"), "first edit\n").expect("first edit");
        let root = directory.path().to_string_lossy();
        let porcelain =
            String::from_utf8(status_porcelain(&root).expect("status")).expect("utf8 status");
        let first = worktree_fingerprint(&root, &porcelain).expect("first fingerprint");
        fs::write(directory.path().join("file.txt"), "second edit\n").expect("second edit");
        let unchanged =
            String::from_utf8(status_porcelain(&root).expect("status")).expect("utf8 status");
        let second = worktree_fingerprint(&root, &unchanged).expect("second fingerprint");
        assert_eq!(porcelain, unchanged);
        assert_ne!(first, second);
    }

    #[test]
    fn stage_unstage_and_commit_keep_unstaged_changes_out_of_the_commit() {
        let directory = init_repo();
        fs::write(directory.path().join("tracked.txt"), "base\n").expect("write tracked file");
        git(directory.path(), &["add", "tracked.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);

        fs::write(directory.path().join("tracked.txt"), "worktree edit\n")
            .expect("edit tracked file");
        fs::write(directory.path().join("[draft].txt"), "literal path\n")
            .expect("write literal fixture");
        let hook = directory.path().join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\ngit add tracked.txt\necho ran > hook-ran\n",
        )
        .expect("write malicious hook fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700))
                .expect("make hook executable");
        }
        let (repo_root, generation) = root_and_generation(directory.path());
        let workspace = directory.path().to_string_lossy().into_owned();

        let staged = repository_mutate_blocking(
            workspace.clone(),
            repo_root.clone(),
            generation,
            "stage".into(),
            Some("[draft].txt".into()),
            None,
            None,
        )
        .expect("stage mutation");
        assert!(staged.ok);
        assert!(staged.applied);
        assert_eq!(
            git_stdout(directory.path(), &["diff", "--cached", "--name-only"]),
            "[draft].txt\n"
        );

        let unstaged = repository_mutate_blocking(
            workspace.clone(),
            repo_root.clone(),
            staged.generation.expect("stage generation"),
            "unstage".into(),
            Some("[draft].txt".into()),
            None,
            None,
        )
        .expect("unstage mutation");
        assert!(unstaged.ok);
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());

        let restaged = repository_mutate_blocking(
            workspace.clone(),
            repo_root.clone(),
            unstaged.generation.expect("unstage generation"),
            "stage".into(),
            Some("[draft].txt".into()),
            None,
            None,
        )
        .expect("restage mutation");
        let committed = repository_mutate_blocking(
            workspace,
            repo_root,
            restaged.generation.expect("restage generation"),
            "commit".into(),
            None,
            None,
            Some("commit only the reviewed file".into()),
        )
        .expect("commit mutation");
        assert!(committed.ok);
        assert!(
            !directory.path().join("hook-ran").exists(),
            "repository-controlled hooks must not run during a reviewed commit"
        );
        assert!(committed
            .commit_oid
            .as_deref()
            .is_some_and(|oid| oid.len() == 40));
        assert_eq!(
            git_stdout(
                directory.path(),
                &["show", "--pretty=format:", "--name-only", "HEAD"]
            )
            .trim(),
            "[draft].txt"
        );
        assert_eq!(
            git_stdout(directory.path(), &["diff", "--name-only"]),
            "tracked.txt\n",
            "the unrelated worktree edit must remain uncommitted"
        );
    }

    #[test]
    fn unborn_unstage_and_stale_content_generation_fail_closed() {
        let directory = init_repo();
        fs::write(directory.path().join("new.txt"), "first\n").expect("write unborn file");
        git(directory.path(), &["add", "new.txt"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let workspace = directory.path().to_string_lossy().into_owned();

        let unstaged = repository_mutate_blocking(
            workspace.clone(),
            repo_root.clone(),
            generation,
            "unstage".into(),
            Some("new.txt".into()),
            None,
            None,
        )
        .expect("unborn unstage");
        assert!(unstaged.ok);
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());

        let stale_generation = unstaged.generation.expect("unborn generation");
        fs::write(directory.path().join("new.txt"), "second\n")
            .expect("second edit with unchanged porcelain");
        let rejected = repository_mutate_blocking(
            workspace,
            repo_root,
            stale_generation,
            "stage".into(),
            Some("new.txt".into()),
            None,
            None,
        )
        .expect("stale mutation reply");
        assert!(!rejected.ok);
        assert!(!rejected.applied);
        assert_eq!(rejected.reason.as_deref(), Some("staleGeneration"));
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());
    }

    #[test]
    fn index_lock_is_structured_and_does_not_apply_the_stage() {
        let directory = init_repo();
        fs::write(directory.path().join("locked.txt"), "content\n").expect("write fixture");
        let (repo_root, generation) = root_and_generation(directory.path());
        fs::write(directory.path().join(".git").join("index.lock"), "held\n")
            .expect("create index lock");

        let reply = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "stage".into(),
            Some("locked.txt".into()),
            None,
            None,
        )
        .expect("locked mutation reply");
        assert!(!reply.ok);
        assert!(!reply.applied);
        assert_eq!(reply.reason.as_deref(), Some("indexLocked"));
    }

    #[test]
    fn executable_clean_and_process_filters_fail_closed_before_writes() {
        for filter_kind in ["clean", "process"] {
            let directory = init_repo();
            fs::write(
                directory.path().join(".gitattributes"),
                "file.txt filter=danger\n",
            )
            .expect("write attributes");
            fs::write(directory.path().join("file.txt"), "base\n").expect("write tracked file");
            git(directory.path(), &["add", ".gitattributes", "file.txt"]);
            git(directory.path(), &["commit", "-q", "-m", "base"]);
            fs::write(directory.path().join("file.txt"), "reviewed change\n")
                .expect("edit tracked file");
            let (repo_root, generation) = root_and_generation(directory.path());
            git(
                directory.path(),
                &[
                    "config",
                    &format!("filter.danger.{filter_kind}"),
                    "echo ran > filter-ran",
                ],
            );

            let status_error = status_porcelain(&repo_root).expect_err("unsafe status must fail");
            assert!(status_error.starts_with("unsafeRepositoryConfiguration:"));
            assert!(!directory.path().join("filter-ran").exists());

            let reply = repository_mutate_blocking(
                directory.path().to_string_lossy().into_owned(),
                repo_root,
                generation,
                "stage".into(),
                Some("file.txt".into()),
                None,
                None,
            )
            .expect("unsafe filter mutation reply");
            assert!(!reply.ok);
            assert!(!reply.applied);
            assert_eq!(
                reply.reason.as_deref(),
                Some("unsafeRepositoryConfiguration")
            );
            assert!(!directory.path().join("filter-ran").exists());
            assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());
        }
    }
    #[test]
    fn repository_drift_is_rejected_before_any_write() {
        let workspace = init_repo();
        let other = init_repo();
        fs::write(workspace.path().join("file.txt"), "content\n").expect("write fixture");
        let (_, generation) = root_and_generation(workspace.path());
        let other_root = other.path().to_string_lossy().into_owned();

        let reply = repository_mutate_blocking(
            workspace.path().to_string_lossy().into_owned(),
            other_root,
            generation,
            "stage".into(),
            Some("file.txt".into()),
            None,
            None,
        )
        .expect("repository drift reply");
        assert!(!reply.ok);
        assert!(!reply.applied);
        assert_eq!(reply.reason.as_deref(), Some("repositoryChanged"));
        assert!(git_stdout(workspace.path(), &["diff", "--cached", "--name-only"]).is_empty());
    }

    #[test]
    fn commit_ignores_repository_post_commit_hooks() {
        let directory = init_repo();
        fs::write(directory.path().join("committed.txt"), "content\n").expect("write fixture");
        git(directory.path(), &["add", "committed.txt"]);

        let hook = directory
            .path()
            .join(".git")
            .join("hooks")
            .join("post-commit");
        fs::write(&hook, "#!/bin/sh\nprintf '[broken\\n' > .git/config\n")
            .expect("write post-commit hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(&hook).expect("hook metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&hook, permissions).expect("make hook executable");
        }

        let (repo_root, generation) = root_and_generation(directory.path());
        let reply = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "commit".into(),
            None,
            None,
            Some("commit before refresh failure".into()),
        )
        .expect("commit reply");
        assert!(reply.ok);
        assert!(reply.applied);
        assert_eq!(reply.reason, None);
        assert!(
            !fs::read_to_string(directory.path().join(".git/config"))
                .expect("read intact config")
                .starts_with("[broken"),
            "post-commit hook must not have run"
        );
        let head =
            fs::read_to_string(directory.path().join(".git").join("HEAD")).expect("read HEAD");
        let reference = head.trim().strip_prefix("ref: ").expect("symbolic HEAD");
        let oid = fs::read_to_string(directory.path().join(".git").join(reference))
            .expect("read committed ref");
        assert_eq!(
            oid.trim().len(),
            40,
            "the commit was written before refresh failed"
        );
    }

    #[test]
    fn concurrent_index_changes_never_enter_a_reviewed_commit() {
        let directory = init_repo();
        fs::write(directory.path().join("base.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "base.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        fs::write(directory.path().join("reviewed.txt"), "reviewed\n").expect("write reviewed");
        fs::write(directory.path().join("intruder.txt"), "intruder\n").expect("write intruder");
        git(directory.path(), &["add", "reviewed.txt"]);
        let old_head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let target = repo_root.clone();
        set_mutation_test_hook(Some(Box::new(move |checkpoint, root| {
            if checkpoint == "before-index-lock" && root == target {
                let status = Command::new("git")
                    .arg("-C")
                    .arg(root)
                    .args(["add", "intruder.txt"])
                    .status()
                    .expect("run concurrent git add before lock");
                assert!(status.success());
            }
        })));
        let stale = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "commit".into(),
            None,
            None,
            Some("must be rejected".into()),
        )
        .expect("stale commit reply");
        set_mutation_test_hook(None);
        assert!(!stale.ok);
        assert!(!stale.applied);
        assert_eq!(stale.reason.as_deref(), Some("staleGeneration"));
        assert_eq!(
            git_stdout(directory.path(), &["rev-parse", "HEAD"]),
            old_head
        );

        git(
            directory.path(),
            &["reset", "-q", "HEAD", "--", "intruder.txt"],
        );
        let (repo_root, generation) = root_and_generation(directory.path());
        let attempts = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = attempts.clone();
        let target = repo_root.clone();
        set_mutation_test_hook(Some(Box::new(move |checkpoint, root| {
            if matches!(checkpoint, "after-index-lock" | "after-write-tree") && root == target {
                let status = Command::new("git")
                    .arg("-C")
                    .arg(root)
                    .args(["add", "intruder.txt"])
                    .status()
                    .expect("run concurrent git add while locked");
                observed
                    .lock()
                    .expect("attempt observations")
                    .push(status.success());
            }
        })));
        let committed = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "commit".into(),
            None,
            None,
            Some("reviewed only".into()),
        )
        .expect("locked commit reply");
        set_mutation_test_hook(None);
        assert!(committed.ok, "{:?}", committed.detail);
        assert_eq!(
            attempts.lock().expect("attempt observations").as_slice(),
            &[false, false]
        );
        assert_eq!(
            git_stdout(directory.path(), &["show", "HEAD:reviewed.txt"]),
            "reviewed\n"
        );
        let intruder = Command::new("git")
            .arg("-C")
            .arg(directory.path())
            .args(["show", "HEAD:intruder.txt"])
            .output()
            .expect("inspect committed tree");
        assert!(!intruder.status.success(), "unreviewed path entered commit");
    }
}
