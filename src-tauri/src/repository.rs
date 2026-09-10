use crate::pi_bridge::PiProc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
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
const STAGED_DRAFT_MAX_BYTES: usize = 256 * 1024;
const GIT_TIMEOUT: Duration = Duration::from_secs(30);

const MUTATION_BATCH_MAX_FILES: usize = 4096;
const MUTATION_BATCH_MAX_PATH_BYTES: usize = 16 * 1024;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryBranchReply {
    name: String,
    oid: String,
}

#[derive(Clone, Debug, Default)]
struct RepositoryMetadata {
    upstream_remote: Option<String>,
    upstream_branch: Option<String>,
    upstream_oid: Option<String>,
    merge_base_oid: Option<String>,
    remotes: Vec<String>,
    branches: Vec<RepositoryBranchReply>,
}

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
    upstream_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_base_oid: Option<String>,
    remotes: Vec<String>,
    branches: Vec<RepositoryBranchReply>,
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
    upstream_remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    merge_base_oid: Option<String>,
    remotes: Vec<String>,
    branches: Vec<RepositoryBranchReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    commit_oid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
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

#[derive(Clone, Copy)]
enum GitConfigScope {
    Isolated,
    EffectiveIdentityRead,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrustedCredentialHelperKind {
    Manager,
    ManagerCore,
}

fn credential_helper_command(path: &Path) -> Result<String, String> {
    let rendered = path.to_str().ok_or_else(|| {
        "remoteAuthenticationUnavailable: The configured Git Credential Manager path is invalid."
            .to_owned()
    })?;
    if rendered.is_empty() || rendered.chars().any(char::is_control) {
        return Err(
            "remoteAuthenticationUnavailable: The configured Git Credential Manager path is invalid."
                .into(),
        );
    }
    #[cfg(windows)]
    let rendered = rendered.replace('\\', "/");
    #[cfg(not(windows))]
    let rendered = rendered.to_owned();
    let quoted = rendered.replace('\'', "'\\''");
    Ok(format!("!'{quoted}'"))
}

#[derive(Clone, Debug)]
struct TrustedHttpTransport {
    git_executable: PathBuf,
    credential_helper: Option<PathBuf>,
    path_environment: std::ffi::OsString,
    http_proxy: Option<String>,
}

#[derive(Clone, Copy)]
enum GitIdentityRole {
    AuthorAndCommitter,
    CommitterOnly,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitIdentity {
    name: String,
    email: String,
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
    run_git_with_index_input(root, args, max_bytes, index_path, None)
}

fn run_git_with_index_input(
    root: &str,
    args: &[&str],
    max_bytes: usize,
    index_path: Option<&Path>,
    input: Option<&[u8]>,
) -> Result<Output, String> {
    run_git_with_options(
        root,
        args,
        max_bytes,
        index_path,
        input,
        GitConfigScope::Isolated,
        None,
        None,
        None,
    )
}

fn run_git_with_index_and_identity(
    root: &str,
    args: &[&str],
    max_bytes: usize,
    index_path: Option<&Path>,
    identity: &GitIdentity,
    role: GitIdentityRole,
) -> Result<Output, String> {
    run_git_with_options(
        root,
        args,
        max_bytes,
        index_path,
        None,
        GitConfigScope::Isolated,
        Some((identity, role)),
        None,
        None,
    )
}

fn run_git_with_trusted_http_transport(
    root: &str,
    args: &[&str],
    max_bytes: usize,
    transport: &TrustedHttpTransport,
) -> Result<Output, String> {
    run_git_with_options(
        root,
        args,
        max_bytes,
        None,
        None,
        GitConfigScope::Isolated,
        None,
        Some(transport),
        None,
    )
}

fn run_git_with_options(
    root: &str,
    args: &[&str],
    max_bytes: usize,
    index_path: Option<&Path>,
    input: Option<&[u8]>,
    config_scope: GitConfigScope,
    identity: Option<(&GitIdentity, GitIdentityRole)>,
    transport: Option<&TrustedHttpTransport>,
    executable_override: Option<&Path>,
) -> Result<Output, String> {
    let mut command = if let Some(executable) = executable_override {
        Command::new(executable)
    } else if let Some(transport) = transport {
        Command::new(&transport.git_executable)
    } else {
        Command::new("git")
    };
    for (key, _) in std::env::vars_os() {
        let upper = key.to_string_lossy().to_ascii_uppercase();
        if upper.starts_with("GIT_")
            || upper.starts_with("GCM_")
            || matches!(
                upper.as_str(),
                "SSH_ASKPASS"
                    | "SSH_ASKPASS_REQUIRE"
                    | "HTTP_PROXY"
                    | "HTTPS_PROXY"
                    | "ALL_PROXY"
                    | "NO_PROXY"
            )
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
        .arg("core.untrackedCache=false");
    if let Some(transport) = transport {
        command.env("PATH", &transport.path_environment);
        if let Some(helper) = &transport.credential_helper {
            let helper_command = credential_helper_command(helper)?;
            command
                .arg("-c")
                .arg("credential.helper=")
                .arg("-c")
                .arg("credential.interactive=never")
                .arg("-c")
                .arg(format!("credential.helper={helper_command}"))
                .env("GCM_INTERACTIVE", "Never")
                .env("GCM_GUI_PROMPT", "false");
        }
        if let Some(proxy) = &transport.http_proxy {
            command.arg("-c").arg(format!("http.proxy={proxy}"));
        }
    }
    command
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("LC_ALL", "C")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if matches!(config_scope, GitConfigScope::Isolated) {
        command.env("GIT_CONFIG_NOSYSTEM", "1").env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        );
    }
    if let Some((identity, role)) = identity {
        if matches!(role, GitIdentityRole::AuthorAndCommitter) {
            command
                .env("GIT_AUTHOR_NAME", &identity.name)
                .env("GIT_AUTHOR_EMAIL", &identity.email);
        }
        command
            .env("GIT_COMMITTER_NAME", &identity.name)
            .env("GIT_COMMITTER_EMAIL", &identity.email);
    }
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "gitUnavailable: Git executable was not found".to_owned()
        } else {
            format!("gitUnavailable: cannot start Git: {error}")
        }
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(input) = input {
            stdin
                .write_all(input)
                .map_err(|error| format!("gitUnavailable: cannot write Git input: {error}"))?;
        }
    }
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

fn parse_git_identity(bytes: &[u8]) -> Result<GitIdentity, String> {
    const MAX_IDENTITY_BYTES: usize = 1024;
    if bytes.is_empty() || bytes.len() > MAX_IDENTITY_BYTES {
        return Err(
            "identityUnavailable: Git identity is empty or exceeds its safety limit.".into(),
        );
    }
    let value = std::str::from_utf8(bytes)
        .map_err(|_| "identityUnavailable: Git identity is not valid UTF-8.".to_owned())?;
    let line = value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value);
    if line.is_empty() || line.chars().any(char::is_control) {
        return Err("identityUnavailable: Git identity has an invalid format.".into());
    }
    let (formatted, timing) = line
        .rsplit_once("> ")
        .ok_or("identityUnavailable: Git identity has an invalid format.")?;
    let mut timing = timing.split(' ');
    let timestamp = timing.next().unwrap_or_default();
    let timezone = timing.next().unwrap_or_default();
    if timing.next().is_some()
        || timestamp.parse::<i64>().is_err()
        || timezone.len() != 5
        || !matches!(timezone.as_bytes().first(), Some(b'+') | Some(b'-'))
        || !timezone.as_bytes()[1..].iter().all(u8::is_ascii_digit)
    {
        return Err("identityUnavailable: Git identity has an invalid format.".into());
    }
    let (name, email) = formatted
        .rsplit_once(" <")
        .ok_or("identityUnavailable: Git identity has an invalid format.")?;
    if name.is_empty()
        || email.is_empty()
        || name.trim() != name
        || email.trim() != email
        || name.len() > 512
        || email.len() > 512
        || name.contains('<')
        || name.contains('>')
        || email.contains('<')
        || email.contains('>')
    {
        return Err("identityUnavailable: Git identity has an invalid format.".into());
    }
    Ok(GitIdentity {
        name: name.to_owned(),
        email: email.to_owned(),
    })
}

fn read_effective_git_identity(repo_root: &str) -> Result<GitIdentity, String> {
    let output = run_git_with_options(
        repo_root,
        &["var", "GIT_COMMITTER_IDENT"],
        1025,
        None,
        None,
        GitConfigScope::EffectiveIdentityRead,
        None,
        None,
        None,
    )?;
    if !output.status.success() {
        return Err(
            "identityUnavailable: Configure Git user.name and user.email before creating or rewriting reviewed commits."
                .into(),
        );
    }
    parse_git_identity(&output.stdout)
}

fn parse_trusted_credential_helpers(
    bytes: &[u8],
    selected: &mut Option<TrustedCredentialHelperKind>,
) -> Result<(), String> {
    const MAX_CREDENTIAL_CONFIG_BYTES: usize = 4 * 1024;
    if bytes.len() > MAX_CREDENTIAL_CONFIG_BYTES {
        return Err("remoteAuthenticationUnavailable: Git credential helper configuration exceeded its safety limit.".into());
    }
    if bytes.is_empty() {
        return Ok(());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| {
        "remoteAuthenticationUnavailable: Git credential helper configuration is not valid UTF-8.".to_owned()
    })?;
    let values = text.strip_suffix('\0').ok_or_else(|| {
        "remoteAuthenticationUnavailable: Git credential helper configuration is malformed."
            .to_owned()
    })?;
    for value in values.split('\0') {
        if value.is_empty() {
            *selected = None;
        } else if value.chars().any(char::is_control) || value.trim() != value {
            return Err("remoteAuthenticationUnavailable: Git credential helper configuration is malformed.".into());
        } else {
            if selected.is_some() {
                return Err("remoteAuthenticationUnavailable: Git credential helper configuration is ambiguous.".into());
            }
            *selected = Some(match value {
                "manager" => TrustedCredentialHelperKind::Manager,
                "manager-core" => TrustedCredentialHelperKind::ManagerCore,
                _ => {
                    return Err("remoteAuthenticationUnavailable: Only the operating system Git Credential Manager is supported.".into());
                }
            });
        }
    }
    Ok(())
}

fn read_trusted_credential_helper_kind(
    repo_root: &str,
    git_executable: &Path,
) -> Result<TrustedCredentialHelperKind, String> {
    let mut selected = None;
    for scope in ["--system", "--global"] {
        let output = run_git_with_options(
            repo_root,
            &["config", scope, "--includes", "--null", "--get-all", "credential.helper"],
            4 * 1024 + 1,
            None,
            None,
            GitConfigScope::EffectiveIdentityRead,
            None,
            None,
            Some(git_executable),
        )
        .map_err(|_| {
            "remoteAuthenticationUnavailable: Git credential helper configuration could not be inspected.".to_owned()
        })?;
        if output.status.success() {
            parse_trusted_credential_helpers(&output.stdout, &mut selected)?;
        } else if output.status.code() != Some(1) {
            return Err("remoteAuthenticationUnavailable: Git credential helper configuration could not be inspected.".into());
        }
    }
    selected.ok_or_else(|| {
        "remoteAuthenticationUnavailable: No supported operating-system Git Credential Manager is configured.".to_owned()
    })
}
fn parse_trusted_http_proxy(bytes: &[u8]) -> Result<String, String> {
    const MAX_TRUSTED_PROXY_BYTES: usize = 4 * 1024;
    let invalid =
        || "remoteUnavailable: The trusted Git HTTP proxy configuration is invalid.".to_owned();
    if bytes.is_empty() || bytes.len() > MAX_TRUSTED_PROXY_BYTES {
        return Err(invalid());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| invalid())?;
    let value = text.strip_suffix('\0').ok_or_else(&invalid)?;
    if value.contains('\0')
        || value.contains('\\')
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(invalid());
    }
    if value.is_empty() {
        return Ok(String::new());
    }
    let lower = value.to_ascii_lowercase();
    let scheme_length = if lower.starts_with("http://") {
        7
    } else if lower.starts_with("https://") {
        8
    } else {
        return Err(invalid());
    };
    let authority = value[scheme_length..].split('/').next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return Err(invalid());
    }
    let parsed = url::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(value.to_owned())
}

fn read_trusted_http_proxy(
    repo_root: &str,
    remote_url: &str,
    git_executable: &Path,
) -> Result<Option<String>, String> {
    let mut selected = None;
    for scope in ["--system", "--global"] {
        let output = run_git_with_options(
            repo_root,
            &[
                "config",
                scope,
                "--no-includes",
                "--null",
                "--get-urlmatch",
                "http.proxy",
                remote_url,
            ],
            4 * 1024 + 1,
            None,
            None,
            GitConfigScope::EffectiveIdentityRead,
            None,
            None,
            Some(git_executable),
        )
        .map_err(|_| {
            "remoteUnavailable: The trusted Git HTTP proxy configuration could not be inspected."
                .to_owned()
        })?;
        if output.status.success() {
            selected = Some(parse_trusted_http_proxy(&output.stdout)?);
        } else if output.status.code() != Some(1) {
            return Err(
                "remoteUnavailable: The trusted Git HTTP proxy configuration could not be inspected."
                    .into(),
            );
        }
    }
    Ok(selected)
}

#[cfg(windows)]
fn windows_program_files_roots() -> Vec<PathBuf> {
    use std::ffi::{c_void, OsString};
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Globalization::lstrlenW;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86, SHGetKnownFolderPath,
    };

    fn known_folder(folder_id: &windows_sys::core::GUID) -> Option<PathBuf> {
        unsafe {
            let mut path_pointer = std::ptr::null_mut();
            let result = SHGetKnownFolderPath(folder_id, 0, HANDLE::default(), &mut path_pointer);
            if result != 0 || path_pointer.is_null() {
                CoTaskMemFree(path_pointer.cast::<c_void>());
                return None;
            }
            let length = lstrlenW(path_pointer) as usize;
            let path = std::slice::from_raw_parts(path_pointer, length);
            let value = PathBuf::from(OsString::from_wide(path));
            CoTaskMemFree(path_pointer.cast::<c_void>());
            Some(value)
        }
    }

    let mut roots = Vec::new();
    for folder_id in [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86] {
        if let Some(root) = known_folder(folder_id) {
            if !roots.iter().any(|existing: &PathBuf| {
                existing
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&root.to_string_lossy())
            }) {
                roots.push(root);
            }
        }
    }
    roots
}

#[cfg(windows)]
fn windows_system_directory() -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

    unsafe {
        let required = GetSystemDirectoryW(std::ptr::null_mut(), 0);
        if required == 0 {
            return None;
        }
        let mut buffer = vec![0_u16; required as usize + 1];
        let length = GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32);
        if length == 0 || length as usize >= buffer.len() {
            return None;
        }
        let directory = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        let canonical = fs::canonicalize(directory).ok()?;
        fs::metadata(&canonical)
            .ok()
            .filter(|metadata| metadata.is_dir())
            .map(|_| canonical)
    }
}

#[cfg(windows)]
fn trusted_git_executable(repo_root: &str) -> Result<PathBuf, String> {
    let canonical_repo = fs::canonicalize(repo_root)
        .map_err(|_| "gitUnavailable: The repository identity could not be verified.".to_owned())?;
    let trusted_roots: Vec<PathBuf> = windows_program_files_roots()
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .collect();
    let mut candidates: Vec<PathBuf> = trusted_roots
        .iter()
        .map(|root| root.join("Git").join("cmd").join("git.exe"))
        .collect();
    if let Some(path_value) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path_value)
                .filter(|directory| directory.is_absolute())
                .map(|directory| directory.join("git.exe")),
        );
    }
    for candidate in candidates {
        if fs::symlink_metadata(&candidate)
            .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(executable) = fs::canonicalize(&candidate) else {
            continue;
        };
        let Some(command_directory) = executable.parent() else {
            continue;
        };
        if !command_directory
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("cmd"))
            || !executable
                .file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("git.exe"))
        {
            continue;
        }
        let Some(git_root) = command_directory
            .parent()
            .and_then(|root| fs::canonicalize(root).ok())
        else {
            continue;
        };
        if trusted_roots.iter().any(|root| git_root.starts_with(root))
            && executable.starts_with(&git_root)
            && !executable.starts_with(&canonical_repo)
        {
            return Ok(executable);
        }
    }
    Err("gitUnavailable: The trusted Git executable is unavailable.".into())
}

#[cfg(windows)]
fn trusted_git_path_entries(git_executable: &Path) -> Result<Vec<PathBuf>, String> {
    let git_root = git_executable
        .parent()
        .and_then(Path::parent)
        .and_then(|root| fs::canonicalize(root).ok())
        .ok_or_else(|| {
            "gitUnavailable: The trusted Git installation path is unavailable.".to_owned()
        })?;
    let mut paths = Vec::new();
    for candidate in [
        git_root.join("cmd"),
        git_root.join("usr").join("bin"),
        git_root.join("mingw64").join("libexec").join("git-core"),
    ] {
        let canonical = fs::canonicalize(candidate).map_err(|_| {
            "gitUnavailable: The trusted Git execution path is unavailable.".to_owned()
        })?;
        if !canonical.starts_with(&git_root)
            || !fs::metadata(&canonical)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false)
        {
            return Err("gitUnavailable: The trusted Git execution path is unavailable.".into());
        }
        if !paths.contains(&canonical) {
            paths.push(canonical);
        }
    }
    if let Some(system_directory) = windows_system_directory() {
        paths.push(system_directory);
    }
    Ok(paths)
}

#[cfg(windows)]
fn trusted_credential_helper_path(
    repo_root: &str,
    kind: TrustedCredentialHelperKind,
    git_executable: &Path,
) -> Result<PathBuf, String> {
    let git_root = git_executable
        .parent()
        .and_then(Path::parent)
        .and_then(|root| fs::canonicalize(root).ok())
        .ok_or_else(|| {
            "remoteAuthenticationUnavailable: The trusted Git installation path is unavailable."
                .to_owned()
        })?;
    let file_name = match kind {
        TrustedCredentialHelperKind::Manager => "git-credential-manager.exe",
        TrustedCredentialHelperKind::ManagerCore => "git-credential-manager-core.exe",
    };
    let candidate = git_root.join("mingw64").join("bin").join(file_name);
    if fs::symlink_metadata(&candidate)
        .map(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
        .unwrap_or(true)
    {
        return Err("remoteAuthenticationUnavailable: The configured Git Credential Manager is not trusted.".into());
    }
    let helper = fs::canonicalize(&candidate).map_err(|_| {
        "remoteAuthenticationUnavailable: The configured Git Credential Manager is not trusted."
            .to_owned()
    })?;
    let canonical_repo = fs::canonicalize(repo_root).map_err(|_| {
        "remoteAuthenticationUnavailable: The repository identity could not be verified.".to_owned()
    })?;
    if !helper.starts_with(&git_root) || helper.starts_with(canonical_repo) {
        return Err("remoteAuthenticationUnavailable: The configured Git Credential Manager is not trusted.".into());
    }
    Ok(helper)
}

#[cfg(unix)]
fn unix_path_is_secure(path: &Path, executable_file: bool) -> bool {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let mut current = Some(path);
    let mut first = true;
    while let Some(candidate) = current {
        let Ok(metadata) = fs::metadata(candidate) else {
            return false;
        };
        if metadata.uid() != 0
            || metadata.permissions().mode() & 0o022 != 0
            || (first && executable_file && metadata.permissions().mode() & 0o111 == 0)
            || (first && !metadata.is_file())
            || (!first && !metadata.is_dir())
        {
            return false;
        }
        first = false;
        current = candidate.parent();
    }
    true
}

#[cfg(unix)]
fn trusted_git_executable(repo_root: &str) -> Result<PathBuf, String> {
    let canonical_repo = fs::canonicalize(repo_root)
        .map_err(|_| "gitUnavailable: The repository identity could not be verified.".to_owned())?;
    [
        PathBuf::from("/usr/bin/git"),
        PathBuf::from("/usr/local/bin/git"),
        PathBuf::from("/opt/homebrew/bin/git"),
        PathBuf::from("/bin/git"),
    ]
    .into_iter()
    .find_map(|candidate| {
        let executable = fs::canonicalize(candidate).ok()?;
        let trusted_prefix = [
            Path::new("/usr"),
            Path::new("/usr/local"),
            Path::new("/opt"),
        ]
        .iter()
        .any(|prefix| executable.starts_with(prefix));
        (trusted_prefix
            && executable.file_name() == Some(std::ffi::OsStr::new("git"))
            && unix_path_is_secure(&executable, true)
            && !executable.starts_with(&canonical_repo))
        .then_some(executable)
    })
    .ok_or_else(|| "gitUnavailable: The trusted Git executable is unavailable.".to_owned())
}

#[cfg(unix)]
fn trusted_git_path_entries(git_executable: &Path) -> Result<Vec<PathBuf>, String> {
    let mut path_entries = Vec::new();
    for directory in [
        git_executable.parent().map(Path::to_path_buf),
        Some(PathBuf::from("/usr/local/bin")),
        Some(PathBuf::from("/usr/bin")),
        Some(PathBuf::from("/bin")),
    ]
    .into_iter()
    .flatten()
    {
        if unix_path_is_secure(&directory, false) && !path_entries.contains(&directory) {
            path_entries.push(directory);
        }
    }
    if path_entries.is_empty() {
        return Err("gitUnavailable: The trusted Git execution path is unavailable.".into());
    }
    Ok(path_entries)
}

#[cfg(unix)]
fn trusted_credential_helper_path(
    repo_root: &str,
    kind: TrustedCredentialHelperKind,
    _git_executable: &Path,
) -> Result<PathBuf, String> {
    let file_name = match kind {
        TrustedCredentialHelperKind::Manager => "git-credential-manager",
        TrustedCredentialHelperKind::ManagerCore => "git-credential-manager-core",
    };
    let candidates = [
        PathBuf::from("/usr/bin").join(file_name),
        PathBuf::from("/usr/local/bin").join(file_name),
        PathBuf::from("/usr/share/gcm-core").join(file_name),
        PathBuf::from("/usr/local/share/gcm-core").join(file_name),
        PathBuf::from("/opt/homebrew/bin").join(file_name),
        PathBuf::from("/opt/homebrew/share/gcm-core").join(file_name),
        PathBuf::from("/opt/git-credential-manager").join(file_name),
        PathBuf::from("/opt/git-credential-manager/bin").join(file_name),
    ];
    let canonical_repo = fs::canonicalize(repo_root).map_err(|_| {
        "remoteAuthenticationUnavailable: The repository identity could not be verified.".to_owned()
    })?;
    for candidate in candidates {
        let Ok(helper) = fs::canonicalize(&candidate) else {
            continue;
        };
        let trusted_prefix = [
            Path::new("/usr"),
            Path::new("/usr/local"),
            Path::new("/opt"),
        ]
        .iter()
        .any(|prefix| helper.starts_with(prefix));
        let original_parent_secure = candidate
            .parent()
            .is_some_and(|parent| unix_path_is_secure(parent, false));
        if trusted_prefix
            && original_parent_secure
            && helper.file_name() == Some(std::ffi::OsStr::new(file_name))
            && unix_path_is_secure(&helper, true)
            && !helper.starts_with(&canonical_repo)
        {
            return Ok(helper);
        }
    }
    Err(
        "remoteAuthenticationUnavailable: The configured Git Credential Manager is not trusted."
            .into(),
    )
}

fn trusted_http_transport(
    repo_root: &str,
    remote_url: &str,
    git_executable: PathBuf,
) -> Result<Option<TrustedHttpTransport>, String> {
    let lower = remote_url.to_ascii_lowercase();
    let https = lower.starts_with("https://");
    if !https && !lower.starts_with("http://") {
        return Ok(None);
    }
    let http_proxy = read_trusted_http_proxy(repo_root, remote_url, &git_executable)?;
    let credential_helper = if https {
        let kind = read_trusted_credential_helper_kind(repo_root, &git_executable)?;
        Some(trusted_credential_helper_path(
            repo_root,
            kind,
            &git_executable,
        )?)
    } else {
        None
    };
    let mut path_entries = trusted_git_path_entries(&git_executable)?;
    if let Some(parent) = credential_helper.as_deref().and_then(Path::parent) {
        let parent = fs::canonicalize(parent).map_err(|_| {
            "remoteAuthenticationUnavailable: The trusted Git credential execution path is unavailable.".to_owned()
        })?;
        if !path_entries.contains(&parent) {
            path_entries.insert(0, parent);
        }
    }
    let path_environment = std::env::join_paths(path_entries)
        .map_err(|_| "gitUnavailable: The trusted Git execution path is unavailable.".to_owned())?;
    Ok(Some(TrustedHttpTransport {
        git_executable,
        credential_helper,
        path_environment,
        http_proxy,
    }))
}

fn remote_authentication_failed(detail: &str) -> bool {
    detail.lines().any(|line| {
        let lower = line.trim().to_ascii_lowercase();
        if lower.starts_with("remote:") {
            return false;
        }
        lower.starts_with("fatal: authentication failed")
            || lower.starts_with("fatal: could not read username")
            || lower.starts_with("fatal: could not read password")
            || lower.starts_with("fatal: terminal prompts disabled")
            || (lower.starts_with("fatal: unable to access ")
                && (lower.contains("the requested url returned error: 401")
                    || lower.contains("the requested url returned error: 403")))
            || lower.starts_with("error: 401 unauthorized")
            || lower.starts_with("error: 403 forbidden")
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
        upstream_remote: None,
        upstream_branch: None,
        upstream_oid: None,
        merge_base_oid: None,
        remotes: Vec::new(),
        branches: Vec::new(),
        reason: Some(reason.to_owned()),
        detail: Some(detail.into()),
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_owned()
}

fn git_failure_detail(output: &Output) -> String {
    [output.stderr.as_slice(), output.stdout.as_slice()]
        .into_iter()
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_owned())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
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
        ("sequencer", "cherryPick"),
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
    if path.is_empty()
        || path.len() > 4096
        || Path::new(path).is_absolute()
        || path.chars().any(char::is_control)
    {
        return false;
    }
    !Path::new(path).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    })
}

fn ensure_safe_repository_config_with_git(
    repo_root: &str,
    git_executable: Option<&Path>,
) -> Result<(), String> {
    let output = run_git_with_options(
        repo_root,
        &[
            "config",
            "--includes",
            "--get-regexp",
            r"^filter\..*\.(clean|process|smudge)$",
        ],
        METADATA_MAX_BYTES,
        None,
        None,
        GitConfigScope::Isolated,
        None,
        None,
        git_executable,
    )
    .map_err(|_| {
        "gitUnavailable: Repository filter configuration could not be inspected.".to_owned()
    })?;
    if output.status.success() && !output.stdout.is_empty() {
        return Err(
            "unsafeRepositoryConfiguration: executable Git clean filters are not supported"
                .to_owned(),
        );
    }
    if output.status.code() != Some(1) {
        return Err(
            "gitUnavailable: Repository filter configuration could not be inspected.".into(),
        );
    }
    Ok(())
}

fn ensure_safe_repository_config(repo_root: &str) -> Result<(), String> {
    ensure_safe_repository_config_with_git(repo_root, None)
}

const PHASE4B_REBASE_MAX_COMMITS: usize = 256;

fn ensure_safe_phase4b_config(repo_root: &str) -> Result<(), String> {
    ensure_safe_repository_config(repo_root)?;
    let output = run_git(
        repo_root,
        &["config", "--includes", "--name-only", "--get-regexp", "."],
        METADATA_MAX_BYTES,
    )?;
    if output.status.code() == Some(1) {
        return Ok(());
    }
    if !output.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect repository merge configuration: {}",
            stderr(&output)
        ));
    }
    let keys = std::str::from_utf8(&output.stdout).map_err(|_| {
        "unsafeRepositoryConfiguration: non-UTF-8 Git configuration cannot be integrated safely"
            .to_owned()
    })?;
    if keys.lines().map(str::trim).any(|key| {
        let key = key.to_ascii_lowercase();
        (key.starts_with("merge.") && key.ends_with(".driver"))
            || (key.starts_with("branch.") && key.ends_with(".mergeoptions"))
    }) {
        return Err(
            "unsafeRepositoryConfiguration: executable Git merge drivers and configured merge options are not supported"
                .to_owned(),
        );
    }
    Ok(())
}

fn decoded_nul_paths(bytes: &[u8]) -> Result<Vec<String>, String> {
    std::str::from_utf8(bytes)
        .map_err(|_| {
            "unsafeRepositoryConfiguration: non-UTF-8 repository paths cannot be integrated safely"
                .to_owned()
        })
        .map(|value| {
            value
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
                .collect()
        })
}

fn history_touched_paths(
    repo_root: &str,
    merge_base_oid: &str,
    tip_oid: &str,
    label: &str,
    paths: &mut HashSet<String>,
) -> Result<(), String> {
    let range = format!("{merge_base_oid}..{tip_oid}");
    let output = run_git(
        repo_root,
        &[
            "log",
            "--format=",
            "--name-only",
            "-z",
            "--no-renames",
            "-m",
            &range,
            "--",
        ],
        STATUS_MAX_BYTES + 1,
    )?;
    if !output.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect {label} integration paths: {}",
            stderr(&output)
        ));
    }
    if output.stdout.len() > STATUS_MAX_BYTES {
        return Err(format!(
            "gitUnavailable: {label} integration path review exceeded its safety limit"
        ));
    }
    for path in decoded_nul_paths(&output.stdout)? {
        if !valid_repository_path(&path) {
            return Err(
                "unsafeRepositoryConfiguration: an integration path is not repository-relative"
                    .to_owned(),
            );
        }
        paths.insert(path);
    }
    Ok(())
}

fn has_phase4b_untracked_collision(
    repo_root: &str,
    merge_base_oid: &str,
    head_oid: &str,
    upstream_oid: &str,
) -> Result<bool, String> {
    let mut touched = HashSet::new();
    history_touched_paths(repo_root, merge_base_oid, head_oid, "local", &mut touched)?;
    history_touched_paths(
        repo_root,
        merge_base_oid,
        upstream_oid,
        "upstream",
        &mut touched,
    )?;
    let tracked = run_git(repo_root, &["ls-files", "-z"], STATUS_MAX_BYTES + 1)?;
    if !tracked.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect tracked paths: {}",
            stderr(&tracked)
        ));
    }
    if tracked.stdout.len() > STATUS_MAX_BYTES {
        return Err("gitUnavailable: tracked path review exceeded its safety limit".into());
    }
    let tracked = decoded_nul_paths(&tracked.stdout)?
        .into_iter()
        .collect::<HashSet<_>>();
    for relative in touched {
        if tracked.contains(&relative) {
            continue;
        }
        let candidate = Path::new(repo_root).join(&relative);
        if fs::symlink_metadata(&candidate).is_ok() {
            return Ok(true);
        }
        let mut ancestor = candidate.parent();
        while let Some(path) = ancestor {
            if path == Path::new(repo_root) {
                break;
            }
            if let Ok(metadata) = fs::symlink_metadata(path) {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Ok(true);
                }
            }
            ancestor = path.parent();
        }
    }
    Ok(false)
}

fn unrelated_branch_refs(repo_root: &str, local_branch: &str) -> Result<Vec<String>, String> {
    let output = run_git(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname)",
            "refs/heads",
        ],
        STATUS_MAX_BYTES + 1,
    )?;
    if !output.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect local branch refs: {}",
            stderr(&output)
        ));
    }
    if output.stdout.len() > STATUS_MAX_BYTES {
        return Err("gitUnavailable: local branch review exceeded its safety limit".into());
    }
    let value = std::str::from_utf8(&output.stdout).map_err(|_| {
        "unsafeRepositoryConfiguration: non-UTF-8 local branch refs cannot be integrated safely"
            .to_owned()
    })?;
    Ok(value
        .lines()
        .filter(|line| {
            line.split_once('\t')
                .is_some_and(|(name, _)| name != local_branch)
        })
        .map(str::to_owned)
        .collect())
}

fn revision_count(repo_root: &str, from: &str, to: &str) -> Result<usize, String> {
    let range = format!("{from}..{to}");
    let value = git_stdout_optional(repo_root, &["rev-list", "--count", &range])?
        .ok_or("gitUnavailable: Git did not return a revision count")?;
    value
        .parse::<usize>()
        .map_err(|_| "gitUnavailable: Git returned an invalid revision count".to_owned())
}

fn local_range_has_merge(
    repo_root: &str,
    merge_base_oid: &str,
    head_oid: &str,
) -> Result<bool, String> {
    let range = format!("{merge_base_oid}..{head_oid}");
    let output = run_git(
        repo_root,
        &["rev-list", "--merges", "--max-count=1", &range],
        METADATA_MAX_BYTES,
    )?;
    if !output.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect the reviewed local history: {}",
            stderr(&output)
        ));
    }
    Ok(!output.stdout.is_empty())
}

fn is_ancestor(repo_root: &str, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let output = run_git(
        repo_root,
        &["merge-base", "--is-ancestor", ancestor, descendant],
        METADATA_MAX_BYTES,
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(format!(
            "gitUnavailable: cannot verify integration ancestry: {}",
            stderr(&output)
        )),
    }
}

fn git_stdout_optional(repo_root: &str, args: &[&str]) -> Result<Option<String>, String> {
    let output = run_git(repo_root, args, METADATA_MAX_BYTES)?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Ok((!value.is_empty()).then_some(value));
    }
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    Err(format!("gitUnavailable: {}", stderr(&output)))
}

fn repository_metadata(repo_root: &str) -> Result<RepositoryMetadata, String> {
    let remotes_output = run_git(repo_root, &["remote"], METADATA_MAX_BYTES)?;
    if !remotes_output.status.success() {
        return Err(format!("gitUnavailable: {}", stderr(&remotes_output)));
    }
    let mut remotes = String::from_utf8_lossy(&remotes_output.stdout)
        .lines()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    remotes.sort();
    remotes.dedup();

    let branches_output = run_git(
        repo_root,
        &[
            "for-each-ref",
            "--format=%(refname:short)\t%(objectname)",
            "refs/heads",
        ],
        STATUS_MAX_BYTES,
    )?;
    if !branches_output.status.success() {
        return Err(format!("gitUnavailable: {}", stderr(&branches_output)));
    }
    let mut branches = String::from_utf8_lossy(&branches_output.stdout)
        .lines()
        .filter_map(|line| {
            let (name, oid) = line.split_once('\t')?;
            (!name.is_empty() && !oid.is_empty()).then(|| RepositoryBranchReply {
                name: name.to_owned(),
                oid: oid.to_owned(),
            })
        })
        .collect::<Vec<_>>();
    branches.sort_by(|left, right| left.name.cmp(&right.name));

    let branch = git_stdout_optional(repo_root, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let head_oid = git_stdout_optional(repo_root, &["rev-parse", "--verify", "HEAD"])?;
    let (upstream_remote, upstream_branch, upstream_oid) = if let Some(branch) = branch {
        let remote_key = format!("branch.{branch}.remote");
        let merge_key = format!("branch.{branch}.merge");
        let remote = git_stdout_optional(repo_root, &["config", "--local", "--get", &remote_key])?;
        let merge = git_stdout_optional(repo_root, &["config", "--local", "--get", &merge_key])?
            .and_then(|value| value.strip_prefix("refs/heads/").map(str::to_owned));
        let oid = if let (Some(remote), Some(merge)) = (remote.as_deref(), merge.as_deref()) {
            if !valid_remote_name(repo_root, remote)? || !valid_branch_name(repo_root, merge)? {
                return Err(
                    "unsafeRepositoryConfiguration: the configured upstream cannot form a reviewed refspec"
                        .into(),
                );
            }
            git_stdout_optional(repo_root, &["rev-parse", "--verify", "@{upstream}"])?
        } else {
            None
        };
        (remote, merge, oid)
    } else {
        (None, None, None)
    };
    let merge_base_oid =
        if let (Some(head), Some(upstream)) = (head_oid.as_deref(), upstream_oid.as_deref()) {
            git_stdout_optional(repo_root, &["merge-base", "--", head, upstream])?
        } else {
            None
        };

    Ok(RepositoryMetadata {
        upstream_remote,
        upstream_branch,
        upstream_oid,
        merge_base_oid,
        remotes,
        branches,
    })
}

fn http_remote_url_is_safe(remote_url: &str) -> bool {
    if remote_url
        .chars()
        .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    let lower = remote_url.to_ascii_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return true;
    }
    let scheme_length = if lower.starts_with("https://") { 8 } else { 7 };
    let authority_and_path = &remote_url[scheme_length..];
    let authority = authority_and_path
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if authority.is_empty() || authority.contains('@') || remote_url.contains('\\') {
        return false;
    }
    let Ok(parsed) = url::Url::parse(remote_url) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.host_str().is_some_and(|host| !host.is_empty())
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none()
}
fn ensure_safe_sync_config(
    repo_root: &str,
    remote: &str,
) -> Result<(String, String, PathBuf), String> {
    let git_executable = trusted_git_executable(repo_root)?;
    ensure_safe_repository_config_with_git(repo_root, Some(&git_executable))?;
    let run_trusted = |arguments: &[&str], max_bytes: usize| {
        run_git_with_options(
            repo_root,
            arguments,
            max_bytes,
            None,
            None,
            GitConfigScope::Isolated,
            None,
            None,
            Some(&git_executable),
        )
    };
    let local_config = run_trusted(
        &["config", "--includes", "--name-only", "--get-regexp", "."],
        METADATA_MAX_BYTES,
    )
    .map_err(|_| {
        "remoteUnavailable: Git transport configuration could not be inspected.".to_owned()
    })?;
    if local_config.status.success() {
        let keys = std::str::from_utf8(&local_config.stdout).map_err(|_| {
            "unsafeRepositoryConfiguration: non-UTF-8 Git transport configuration is not supported"
                .to_owned()
        })?;
        let unsafe_key = keys.lines().any(|key| {
            let key = key.to_ascii_lowercase();
            key == "core.askpass"
                || key == "core.sshcommand"
                || key == "core.gitproxy"
                || key.starts_with("http.")
                || (key.starts_with("credential.") && key.ends_with(".helper"))
                || (key.starts_with("remote.")
                    && (key.ends_with(".uploadpack")
                        || key.ends_with(".receivepack")
                        || key.ends_with(".proxy")))
                || (key.starts_with("url.")
                    && (key.ends_with(".insteadof") || key.ends_with(".pushinsteadof")))
        });
        if unsafe_key {
            return Err("unsafeRepositoryConfiguration: executable, credential-bearing, proxying, or redirecting Git transport configuration is not supported".into());
        }
    } else if local_config.status.code() != Some(1) {
        return Err(
            "remoteUnavailable: Git transport configuration could not be inspected.".into(),
        );
    }
    let validate_urls = |arguments: &[&str]| -> Result<Vec<String>, String> {
        let output = run_trusted(arguments, METADATA_MAX_BYTES).map_err(|_| {
            "remoteUnavailable: The selected remote URL could not be resolved.".to_owned()
        })?;
        if !output.status.success() {
            return Err("remoteUnavailable: The selected remote URL could not be resolved.".into());
        }
        let url_output = std::str::from_utf8(&output.stdout).map_err(|_| {
            "unsafeRepositoryConfiguration: non-UTF-8 remote URL is not supported".to_owned()
        })?;
        let urls = url_output
            .lines()
            .filter(|url| !url.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        if urls.is_empty() {
            return Err("remoteUnavailable: The selected remote URL could not be resolved.".into());
        }
        for url in &urls {
            let lower = url.to_ascii_lowercase();
            let allowed = lower.starts_with("https://")
                || lower.starts_with("http://")
                || lower.starts_with("ssh://")
                || lower.starts_with("git://")
                || lower.starts_with("file://")
                || std::path::Path::new(url).is_absolute()
                || url.starts_with("./")
                || url.starts_with("../")
                || (!url.starts_with('-') && url.contains(':') && !url.contains("::"));
            if !allowed {
                return Err("unsafeRepositoryConfiguration: unsupported remote URL scheme".into());
            }
            if !http_remote_url_is_safe(url) {
                return Err("unsafeRepositoryConfiguration: HTTP(S) remote URLs must not contain credentials, queries, fragments, or control characters".into());
            }
        }
        Ok(urls)
    };
    let fetch_urls = validate_urls(&["remote", "get-url", "--all", "--", remote])?;
    let push_urls = validate_urls(&["remote", "get-url", "--push", "--all", "--", remote])?;
    if push_urls.len() != 1 {
        return Err(
            "unsafeRepositoryConfiguration: Push requires exactly one effective destination URL"
                .into(),
        );
    }
    Ok((fetch_urls[0].clone(), push_urls[0].clone(), git_executable))
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

fn validated_mutation_batch_paths(
    porcelain: &str,
    operation: &str,
    reviewed: &[RepositoryMutationFile],
) -> Option<Vec<String>> {
    let entries = mutation_entries(porcelain);
    let mut seen_pathspecs = HashSet::new();
    let mut paths = Vec::with_capacity(reviewed.len());
    for requested in reviewed {
        let entry = entries.iter().find(|entry| entry.path == requested.path)?;
        let allowed = match operation {
            "stageBatch" => entry.worktree_changed,
            "unstageBatch" => entry.index_changed,
            _ => false,
        };
        if !allowed || entry.original_path != requested.original_path {
            return None;
        }
        if seen_pathspecs.insert(entry.path.as_str()) {
            paths.push(entry.path.clone());
        }
        if let Some(original) = entry.original_path.as_ref() {
            if seen_pathspecs.insert(original.as_str()) {
                paths.push(original.clone());
            }
        }
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
        upstream_remote: None,
        upstream_branch: None,
        upstream_oid: None,
        merge_base_oid: None,
        remotes: Vec::new(),
        branches: Vec::new(),
        commit_oid: None,
        text: None,
        reason: Some(reason.to_owned()),
        detail: Some(detail.into()),
        applied,
    }
}

fn require_local_repository_target(target_id: &str) -> Result<(), RepositoryMutationReply> {
    if target_id == "local" {
        Ok(())
    } else {
        Err(mutation_failure(
            "invalidRequest",
            "Local repository commands require the canonical local target.",
            false,
        ))
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
        let metadata = match repository_metadata(&repo_root) {
            Ok(value) => value,
            Err(error) => {
                let reason = if error.starts_with("unsafeRepositoryConfiguration:") {
                    "unsafeRepositoryConfiguration"
                } else {
                    "gitUnavailable"
                };
                return Ok(unavailable(reason, error));
            }
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
            upstream_remote: metadata.upstream_remote,
            upstream_branch: metadata.upstream_branch,
            upstream_oid: metadata.upstream_oid,
            merge_base_oid: metadata.merge_base_oid,
            remotes: metadata.remotes,
            branches: metadata.branches,
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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryMutationFile {
    path: String,
    original_path: Option<String>,
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
    files: Option<Vec<RepositoryMutationFile>>,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if let Err(reply) = require_local_repository_target(&target_id) {
        return Ok(reply);
    }
    let _write_guard = match state.begin_repository_write(&target_id, &workspace_root) {
        Ok(guard) => guard,
        Err(detail) => return Ok(mutation_failure("piBusy", detail, false)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repository_mutate_blocking_with_files(
            workspace_root,
            repo_root,
            generation,
            operation,
            path,
            original_path,
            files,
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
    repository_mutate_blocking_with_files(
        workspace_root,
        repo_root,
        generation,
        operation,
        path,
        original_path,
        None,
        message,
    )
}

fn repository_mutate_blocking_with_files(
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    path: Option<String>,
    original_path: Option<String>,
    files: Option<Vec<RepositoryMutationFile>>,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if !matches!(
        operation.as_str(),
        "stage" | "unstage" | "stageBatch" | "unstageBatch" | "commit"
    ) {
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
    if let Some(entries) = files.as_ref() {
        if entries.is_empty() || entries.len() > MUTATION_BATCH_MAX_FILES {
            return Ok(mutation_failure(
                "invalidRequest",
                format!(
                    "Repository mutation batches must contain 1 to {MUTATION_BATCH_MAX_FILES} reviewed files."
                ),
                false,
            ));
        }
        let mut reviewed_paths = HashSet::with_capacity(entries.len());
        let mut total_path_bytes = 0usize;
        for entry in entries {
            total_path_bytes = total_path_bytes
                .saturating_add(entry.path.len())
                .saturating_add(entry.original_path.as_ref().map_or(0, String::len));
            if !valid_repository_path(&entry.path)
                || entry
                    .original_path
                    .as_deref()
                    .is_some_and(|value| !valid_repository_path(value))
                || total_path_bytes > MUTATION_BATCH_MAX_PATH_BYTES
                || !reviewed_paths.insert(entry.path.as_str())
            {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Repository mutation batch paths must be unique, relative, and remain inside the repository.",
                    false,
                ));
            }
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

    let validated_paths = match operation.as_str() {
        "stage" | "unstage" => {
            let Some(path) = path.as_deref() else {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Stage and unstage require a repository file from the reviewed snapshot.",
                    false,
                ));
            };
            if files.is_some() || message.is_some() {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Single-file stage and unstage do not accept batch files or a commit message.",
                    false,
                ));
            }
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
        }
        "stageBatch" | "unstageBatch" => {
            if path.is_some() || original_path.is_some() || message.is_some() {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Batch stage and unstage accept only reviewed file entries.",
                    false,
                ));
            }
            let Some(reviewed) = files.as_deref() else {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Batch stage and unstage require reviewed file entries.",
                    false,
                ));
            };
            match validated_mutation_batch_paths(&before, &operation, reviewed) {
                Some(paths) => Some(paths),
                None => {
                    return Ok(mutation_failure(
                        "invalidRequest",
                        "Repository batch did not match the reviewed file state.",
                        false,
                    ))
                }
            }
        }
        "commit" => {
            if path.is_some() || original_path.is_some() || files.is_some() {
                return Ok(mutation_failure(
                    "invalidRequest",
                    "Commit does not accept repository paths.",
                    false,
                ));
            }
            None
        }
        _ => unreachable!(),
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
        "stage" | "stageBatch" => {
            let paths = validated_paths
                .as_ref()
                .expect("stage paths were validated");
            let (directory, temporary_index) = match temporary_index(&actual_root) {
                Ok(value) => value,
                Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
            };
            let output = if operation == "stageBatch" {
                let mut pathspecs = Vec::new();
                for path in paths {
                    pathspecs.extend_from_slice(path.as_bytes());
                    pathspecs.push(0);
                }
                run_git_with_index_input(
                    &actual_root,
                    &[
                        "--literal-pathspecs",
                        "add",
                        "--all",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ],
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                    Some(&pathspecs),
                )
            } else {
                let mut args = vec!["--literal-pathspecs", "add", "--all", "--"];
                for path in paths {
                    args.push(path.as_str());
                }
                run_git_with_index(
                    &actual_root,
                    &args,
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                )
            };
            (output, Some(directory))
        }
        "unstage" | "unstageBatch" => {
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
            let output = if operation == "unstageBatch" {
                let mut pathspecs = Vec::new();
                for path in paths {
                    pathspecs.extend_from_slice(path.as_bytes());
                    pathspecs.push(0);
                }
                let args = if has_head {
                    vec![
                        "--literal-pathspecs",
                        "reset",
                        "-q",
                        "HEAD",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ]
                } else {
                    vec![
                        "--literal-pathspecs",
                        "rm",
                        "--cached",
                        "-q",
                        "--ignore-unmatch",
                        "--pathspec-from-file=-",
                        "--pathspec-file-nul",
                    ]
                };
                run_git_with_index_input(
                    &actual_root,
                    &args,
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                    Some(&pathspecs),
                )
            } else {
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
                run_git_with_index(
                    &actual_root,
                    &args,
                    METADATA_MAX_BYTES,
                    Some(&temporary_index),
                )
            };
            (output, Some(directory))
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
            let identity = match read_effective_git_identity(&actual_root) {
                Ok(value) => value,
                Err(error) => return Ok(phase3_error(error, false)),
            };
            mutation_checkpoint("after-identity-resolution", &actual_root);
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
            let commit_tree = run_git_with_index_and_identity(
                &actual_root,
                &commit_args,
                METADATA_MAX_BYTES,
                Some(&temporary_index),
                &identity,
                GitIdentityRole::AuthorAndCommitter,
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
    let batch_mutation = matches!(operation.as_str(), "stageBatch" | "unstageBatch");
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
    if matches!(
        operation.as_str(),
        "stage" | "unstage" | "stageBatch" | "unstageBatch"
    ) {
        mutation_checkpoint("after-temporary-index", &actual_root);
        let prepared_operation = repository_operation(&actual_root);
        let prepared_bytes = match status_porcelain(&actual_root) {
            Ok(value) => value,
            Err(error) => {
                return Ok(mutation_failure(
                    classify_mutation_failure(&error),
                    error,
                    false,
                ))
            }
        };
        let prepared_porcelain = String::from_utf8_lossy(&prepared_bytes).into_owned();
        let prepared_fingerprint = match worktree_fingerprint(&actual_root, &prepared_porcelain) {
            Ok(value) => value,
            Err(error) => return Ok(mutation_failure("gitUnavailable", error, false)),
        };
        if prepared_operation != locked_operation
            || repository_generation(
                &actual_root,
                prepared_operation.as_deref(),
                &prepared_porcelain,
                &prepared_fingerprint,
            ) != generation
        {
            return Ok(mutation_failure(
                "staleGeneration",
                "Repository files changed while the reviewed index update was being prepared.",
                false,
            ));
        }
    }
    if matches!(
        operation.as_str(),
        "stage" | "unstage" | "stageBatch" | "unstageBatch"
    ) {
        let temporary_index = temporary_index_dir
            .as_ref()
            .expect("temporary index directory exists")
            .path()
            .join("index");
        let lock = index_lock.take().expect("repository index lock exists");
        if let Err(error) = lock.install(&temporary_index) {
            return Ok(mutation_failure(
                if batch_mutation {
                    "refreshFailed"
                } else {
                    classify_mutation_failure(&error)
                },
                error,
                batch_mutation,
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
    let metadata = match repository_metadata(&actual_root) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
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
        upstream_remote: metadata.upstream_remote,
        upstream_branch: metadata.upstream_branch,
        upstream_oid: metadata.upstream_oid,
        merge_base_oid: metadata.merge_base_oid,
        remotes: metadata.remotes,
        branches: metadata.branches,
        commit_oid,
        text: None,
        reason: None,
        detail: None,
        applied: true,
    })
}

fn phase3_error(error: String, applied: bool) -> RepositoryMutationReply {
    let reason = error
        .split_once(':')
        .map(|(prefix, _)| prefix)
        .filter(|prefix| {
            matches!(
                *prefix,
                "invalidRequest"
                    | "repositoryChanged"
                    | "staleGeneration"
                    | "conflictsPresent"
                    | "operationInProgress"
                    | "unsafeRepositoryConfiguration"
                    | "detachedHead"
                    | "noUpstream"
                    | "remoteUnavailable"
                    | "remoteAuthenticationUnavailable"
                    | "nothingToPush"
                    | "nonFastForward"
                    | "dirtyWorktree"
                    | "nothingToIntegrate"
                    | "branchExists"
                    | "branchNotFound"
                    | "checkoutConflict"
                    | "stagedDiffTooLarge"
                    | "indexLocked"
                    | "emptyMessage"
                    | "unsupportedHistory"
                    | "identityUnavailable"
                    | "integrationConflict"
                    | "refreshFailed"
            )
        })
        .unwrap_or("gitUnavailable");
    mutation_failure(reason, error.clone(), applied)
}

fn refreshed_phase3_reply(repo_root: String, applied: bool) -> RepositoryMutationReply {
    let operation = repository_operation(&repo_root);
    let porcelain = match status_porcelain(&repo_root) {
        Ok(value) => String::from_utf8_lossy(&value).into_owned(),
        Err(error) => return mutation_failure("refreshFailed", error, applied),
    };
    let fingerprint = match worktree_fingerprint(&repo_root, &porcelain) {
        Ok(value) => value,
        Err(error) => return mutation_failure("refreshFailed", error, applied),
    };
    let metadata = match repository_metadata(&repo_root) {
        Ok(value) => value,
        Err(error) => return mutation_failure("refreshFailed", error, applied),
    };
    RepositoryMutationReply {
        ok: true,
        repo_root: Some(repo_root.clone()),
        porcelain: Some(porcelain.clone()),
        generation: Some(repository_generation(
            &repo_root,
            operation.as_deref(),
            &porcelain,
            &fingerprint,
        )),
        repository_operation: operation,
        upstream_remote: metadata.upstream_remote,
        upstream_branch: metadata.upstream_branch,
        upstream_oid: metadata.upstream_oid,
        merge_base_oid: metadata.merge_base_oid,
        remotes: metadata.remotes,
        branches: metadata.branches,
        commit_oid: None,
        text: None,
        reason: None,
        detail: None,
        applied,
    }
}

fn validate_phase3_snapshot(
    workspace_root: &str,
    repo_root: &str,
    generation: &str,
) -> Result<(String, String, RepositoryMetadata), String> {
    if workspace_root.trim().is_empty() || repo_root.trim().is_empty() || generation.is_empty() {
        return Err("invalidRequest: repository identity and generation are required".into());
    }
    let actual_root = discover_repo_root(workspace_root)?
        .ok_or("repositoryChanged: the workspace is no longer in a Git repository")?;
    if !same_repo(&actual_root, repo_root) {
        return Err("repositoryChanged: repository identity changed; refresh and try again".into());
    }
    let operation = repository_operation(&actual_root);
    let bytes = status_porcelain(&actual_root)?;
    let porcelain = String::from_utf8_lossy(&bytes).into_owned();
    let fingerprint = worktree_fingerprint(&actual_root, &porcelain)?;
    // Configuration can change without touching files or the index. Validate it
    // before reporting a stale content generation so unsafe ref construction
    // always fails with the actionable safety reason.
    let metadata = repository_metadata(&actual_root)?;
    if repository_generation(&actual_root, operation.as_deref(), &porcelain, &fingerprint)
        != generation
    {
        return Err(
            "staleGeneration: repository files or index changed; refresh and review before writing"
                .into(),
        );
    }
    Ok((actual_root, porcelain, metadata))
}

fn valid_branch_name(repo_root: &str, name: &str) -> Result<bool, String> {
    if name.is_empty() || name.len() > 255 || name.trim() != name || name.starts_with('-') {
        return Ok(false);
    }
    let output = run_git(
        repo_root,
        &["check-ref-format", "--branch", name],
        METADATA_MAX_BYTES,
    )?;
    Ok(output.status.success())
}

fn valid_remote_name(repo_root: &str, name: &str) -> Result<bool, String> {
    if name.is_empty() || name.len() > 255 || name.trim() != name || name.starts_with('-') {
        return Ok(false);
    }
    let tracking_probe = format!("refs/remotes/{name}/phase3-validation");
    let output = run_git(
        repo_root,
        &["check-ref-format", &tracking_probe],
        METADATA_MAX_BYTES,
    )?;
    Ok(output.status.success())
}

#[allow(clippy::too_many_arguments)]
fn repository_phase3_blocking(
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    remote: Option<String>,
    expected_head_oid: Option<String>,
    expected_upstream_oid: Option<String>,
    expected_upstream_remote: Option<String>,
    expected_upstream_branch: Option<String>,
    branch_name: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if !matches!(
        operation.as_str(),
        "stagedDiff" | "fetch" | "push" | "createBranch" | "switchBranch"
    ) {
        return Ok(mutation_failure(
            "invalidRequest",
            "Unsupported Phase 3 repository operation.",
            false,
        ));
    }
    let valid_oid = |value: &str| {
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let valid_name = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && value.trim() == value
            && !value.starts_with('-')
            && !value.chars().any(|ch| ch == '\0' || ch.is_control())
    };
    let invalid_payload = match operation.as_str() {
        "stagedDiff" => {
            remote.is_some()
                || expected_head_oid.is_some()
                || expected_upstream_oid.is_some()
                || expected_upstream_remote.is_some()
                || expected_upstream_branch.is_some()
                || branch_name.is_some()
        }
        "fetch" => {
            !remote.as_deref().is_some_and(valid_name)
                || expected_head_oid.is_some()
                || expected_upstream_oid.is_some()
                || expected_upstream_remote.is_some()
                || expected_upstream_branch.is_some()
                || branch_name.is_some()
        }
        "push" => {
            remote.is_some()
                || !expected_head_oid.as_deref().is_some_and(valid_oid)
                || expected_upstream_oid
                    .as_deref()
                    .is_some_and(|value| !valid_oid(value))
                || !expected_upstream_remote.as_deref().is_some_and(valid_name)
                || !expected_upstream_branch.as_deref().is_some_and(valid_name)
                || branch_name.is_some()
        }
        "createBranch" => {
            remote.is_some()
                || !expected_head_oid.as_deref().is_some_and(valid_oid)
                || expected_upstream_oid.is_some()
                || expected_upstream_remote.is_some()
                || expected_upstream_branch.is_some()
                || !branch_name.as_deref().is_some_and(valid_name)
        }
        "switchBranch" => {
            remote.is_some()
                || expected_head_oid.is_some()
                || expected_upstream_oid.is_some()
                || expected_upstream_remote.is_some()
                || expected_upstream_branch.is_some()
                || !branch_name.as_deref().is_some_and(valid_name)
        }
        _ => true,
    };
    if invalid_payload {
        return Ok(mutation_failure(
            "invalidRequest",
            "The Phase 3 repository payload is invalid for this operation.",
            false,
        ));
    }
    let (actual_root, before, metadata) =
        match validate_phase3_snapshot(&workspace_root, &repo_root, &generation) {
            Ok(value) => value,
            Err(error) => return Ok(phase3_error(error, false)),
        };

    if operation == "stagedDiff" {
        let output = match run_git(
            &actual_root,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--src-prefix=a/",
                "--dst-prefix=b/",
                "--",
            ],
            STAGED_DRAFT_MAX_BYTES + 1,
        ) {
            Ok(value) => value,
            Err(error) => return Ok(phase3_error(error, false)),
        };
        if !output.status.success() {
            return Ok(mutation_failure("gitUnavailable", stderr(&output), false));
        }
        if output.stdout.is_empty() {
            return Ok(mutation_failure(
                "nothingStaged",
                "No staged diff is available for a commit draft.",
                false,
            ));
        }
        if output.stdout.len() > STAGED_DRAFT_MAX_BYTES {
            return Ok(mutation_failure(
                "stagedDiffTooLarge",
                "The staged diff is too large for AI commit drafting.",
                false,
            ));
        }
        let mut reply = mutation_failure("gitUnavailable", "", false);
        reply.ok = true;
        reply.reason = None;
        reply.detail = None;
        reply.text = Some(String::from_utf8_lossy(&output.stdout).into_owned());
        return Ok(reply);
    }

    if before.split('\0').any(|record| record.starts_with("u ")) {
        return Ok(mutation_failure(
            "conflictsPresent",
            "Resolve repository conflicts before syncing or switching branches.",
            false,
        ));
    }
    if repository_operation(&actual_root).is_some() {
        return Ok(mutation_failure(
            "operationInProgress",
            "Finish the current Git operation before syncing or switching branches.",
            false,
        ));
    }

    let result: Result<(), String> = match operation.as_str() {
        "fetch" => (|| {
            let remote = remote
                .as_deref()
                .ok_or("invalidRequest: fetch requires a displayed remote")?;
            if !metadata.remotes.iter().any(|candidate| candidate == remote) {
                return Err("remoteUnavailable: the selected remote no longer exists".into());
            }
            if !valid_remote_name(&actual_root, remote)? {
                return Err(
                    "unsafeRepositoryConfiguration: the selected remote name cannot form a tracking ref"
                        .into(),
                );
            }
            let (fetch_url, _, git_executable) = ensure_safe_sync_config(&actual_root, remote)?;
            let transport = trusted_http_transport(&actual_root, &fetch_url, git_executable)?;
            let destination = format!("+refs/heads/*:refs/remotes/{remote}/*");
            let hooks = tempfile::tempdir().map_err(|error| error.to_string())?;
            let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
            let fetch_args = [
                "-c",
                hooks_config.as_str(),
                "fetch",
                "--no-tags",
                "--atomic",
                "--no-write-fetch-head",
                "--recurse-submodules=no",
                "--refmap=",
                "--",
                fetch_url.as_str(),
                destination.as_str(),
            ];
            let output = if let Some(transport) = transport.as_ref() {
                run_git_with_trusted_http_transport(
                    &actual_root,
                    &fetch_args,
                    STATUS_MAX_BYTES,
                    transport,
                )
            } else {
                run_git(&actual_root, &fetch_args, STATUS_MAX_BYTES)
            }?;
            if output.status.success() {
                Ok(())
            } else {
                let detail = stderr(&output);
                if transport
                    .as_ref()
                    .and_then(|transport| transport.credential_helper.as_ref())
                    .is_some()
                    && remote_authentication_failed(&detail)
                {
                    Err("remoteAuthenticationUnavailable: Git credentials for this HTTPS remote are unavailable.".into())
                } else if transport
                    .as_ref()
                    .and_then(|transport| transport.http_proxy.as_deref())
                    .is_some_and(|proxy| !proxy.is_empty())
                {
                    Err("remoteUnavailable: Git could not reach the selected remote through the configured trusted proxy.".into())
                } else {
                    Err("remoteUnavailable: Git could not reach the selected remote.".into())
                }
            }
        })(),
        "push" => {
            (|| {
                let _current_branch =
                    git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"])?
                        .ok_or("detachedHead: pushing is unavailable from detached HEAD")?;
                let head = git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"])?
                    .ok_or("detachedHead: HEAD has no commit")?;
                let expected_head = expected_head_oid
                    .as_deref()
                    .ok_or("invalidRequest: push requires the reviewed HEAD commit")?;
                if head != expected_head {
                    return Err("staleGeneration: HEAD changed; refresh before pushing".into());
                }
                let latest = repository_metadata(&actual_root)?;
                let remote = latest
                    .upstream_remote
                    .as_deref()
                    .ok_or("noUpstream: the current branch has no configured upstream remote")?;
                let upstream_branch = latest
                    .upstream_branch
                    .as_deref()
                    .ok_or("noUpstream: the current branch has no configured upstream branch")?;
                if !valid_remote_name(&actual_root, remote)?
                    || !valid_branch_name(&actual_root, upstream_branch)?
                {
                    return Err(
                        "unsafeRepositoryConfiguration: the configured upstream cannot form the reviewed push refspec"
                            .into(),
                    );
                }
                let reviewed_remote = expected_upstream_remote
                    .as_deref()
                    .ok_or("invalidRequest: push requires the reviewed upstream remote")?;
                let reviewed_branch = expected_upstream_branch
                    .as_deref()
                    .ok_or("invalidRequest: push requires the reviewed upstream branch")?;
                if remote != reviewed_remote || upstream_branch != reviewed_branch {
                    return Err(
                        "staleGeneration: the push destination changed; refresh before pushing"
                            .into(),
                    );
                }
                let reviewed_upstream_oid = expected_upstream_oid.as_deref();
                if latest.upstream_oid.as_deref() != reviewed_upstream_oid {
                    return Err("staleGeneration: the upstream ref changed; fetch and review before pushing".into());
                }
                if latest.upstream_oid.as_deref() == Some(head.as_str()) {
                    return Err("nothingToPush: the current branch has no commits to push".into());
                }
                if let Some(upstream_oid) = reviewed_upstream_oid {
                    let ancestry = run_git(
                        &actual_root,
                        &["merge-base", "--is-ancestor", "--", upstream_oid, &head],
                        METADATA_MAX_BYTES,
                    )?;
                    match ancestry.status.code() {
                        Some(0) => {}
                        Some(1) => {
                            return Err(
                                "nonFastForward: the reviewed upstream is not an ancestor of the reviewed HEAD"
                                    .into(),
                            );
                        }
                        _ => {
                            return Err(format!(
                                "gitUnavailable: the reviewed push ancestry could not be verified: {}",
                                stderr(&ancestry)
                            ));
                        }
                    }
                }
                let (_, push_url, git_executable) = ensure_safe_sync_config(&actual_root, remote)?;
                let transport = trusted_http_transport(&actual_root, &push_url, git_executable)?;
                let destination = format!("refs/heads/{upstream_branch}");
                let lease = format!(
                    "--force-with-lease={destination}:{}",
                    reviewed_upstream_oid.unwrap_or_default()
                );
                // Pin the source to the reviewed commit so a concurrent local ref move can
                // never cause an unreviewed commit to be pushed.
                let refspec = format!("{head}:{destination}");
                let hooks = tempfile::tempdir().map_err(|error| error.to_string())?;
                let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
                let push_args = [
                    "-c",
                    hooks_config.as_str(),
                    "push",
                    "--porcelain",
                    "--no-force",
                    lease.as_str(),
                    "--no-follow-tags",
                    "--recurse-submodules=no",
                    "--",
                    push_url.as_str(),
                    refspec.as_str(),
                ];
                let output = if let Some(transport) = transport.as_ref() {
                    run_git_with_trusted_http_transport(
                        &actual_root,
                        &push_args,
                        STATUS_MAX_BYTES,
                        transport,
                    )
                } else {
                    run_git(&actual_root, &push_args, STATUS_MAX_BYTES)
                }?;
                if output.status.success() {
                    let tracking_ref = format!("refs/remotes/{remote}/{upstream_branch}");
                    let update = run_git(
                        &actual_root,
                        &[
                            "-c",
                            &hooks_config,
                            "update-ref",
                            "--no-deref",
                            &tracking_ref,
                            &head,
                            reviewed_upstream_oid.unwrap_or_default(),
                        ],
                        METADATA_MAX_BYTES,
                    )
                    .map_err(|error| {
                        format!(
                            "refreshFailedApplied: push succeeded, but the local upstream ref could not be refreshed: {error}"
                        )
                    })?;
                    if !update.status.success() {
                        return Err(format!(
                            "refreshFailedApplied: push succeeded, but the local upstream ref could not be refreshed: {}",
                            stderr(&update)
                        ));
                    }
                    Ok(())
                } else {
                    let detail = git_failure_detail(&output);
                    let lower = detail.to_ascii_lowercase();
                    if transport
                        .as_ref()
                        .and_then(|transport| transport.credential_helper.as_ref())
                        .is_some()
                        && remote_authentication_failed(&detail)
                    {
                        Err("remoteAuthenticationUnavailable: Git credentials for this HTTPS remote are unavailable.".into())
                    } else if lower.contains("non-fast-forward")
                        || lower.contains("fetch first")
                        || lower.contains("stale info")
                    {
                        Err("nonFastForward: The remote rejected the reviewed update because its branch moved.".into())
                    } else if transport
                        .as_ref()
                        .and_then(|transport| transport.http_proxy.as_deref())
                        .is_some_and(|proxy| !proxy.is_empty())
                    {
                        Err("remoteUnavailable: Git could not reach the selected remote through the configured trusted proxy.".into())
                    } else {
                        Err("remoteUnavailable: Git could not reach the selected remote.".into())
                    }
                }
            })()
        }
        "createBranch" => (|| {
            let name = branch_name
                .as_deref()
                .ok_or("invalidRequest: branch name is required")?;
            if !valid_branch_name(&actual_root, name)? {
                return Err("invalidRequest: invalid local branch name".into());
            }
            if metadata.branches.iter().any(|branch| branch.name == name) {
                return Err("branchExists: a local branch with this name already exists".into());
            }
            let reviewed_head =
                git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"])?
                    .ok_or("detachedHead: HEAD has no commit")?;
            let expected_head = expected_head_oid
                .as_deref()
                .ok_or("invalidRequest: branch creation requires the reviewed HEAD commit")?;
            if reviewed_head != expected_head {
                return Err(
                    "staleGeneration: HEAD changed; refresh before creating the branch".into(),
                );
            }
            let hooks = tempfile::tempdir().map_err(|error| error.to_string())?;
            let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
            let output = run_git(
                &actual_root,
                &[
                    "-c",
                    &hooks_config,
                    "branch",
                    "--no-track",
                    name,
                    &reviewed_head,
                ],
                METADATA_MAX_BYTES,
            )?;
            if output.status.success() {
                Ok(())
            } else {
                Err(format!("gitUnavailable: {}", stderr(&output)))
            }
        })(),
        "switchBranch" => (|| {
            let name = branch_name
                .as_deref()
                .ok_or("invalidRequest: branch name is required")?;
            if !valid_branch_name(&actual_root, name)? {
                return Err("invalidRequest: invalid local branch name".into());
            }
            if !metadata.branches.iter().any(|branch| branch.name == name) {
                return Err("branchNotFound: the selected local branch no longer exists".into());
            }
            let hooks = tempfile::tempdir().map_err(|error| error.to_string())?;
            let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
            let output = run_git(
                &actual_root,
                &[
                    "-c",
                    &hooks_config,
                    "switch",
                    "--no-guess",
                    "--no-recurse-submodules",
                    name,
                ],
                STATUS_MAX_BYTES,
            )?;
            if output.status.success() {
                Ok(())
            } else {
                let detail = stderr(&output);
                let lower = detail.to_ascii_lowercase();
                let reason =
                    if lower.contains("would be overwritten") || lower.contains("local changes") {
                        "checkoutConflict"
                    } else {
                        "gitUnavailable"
                    };
                Err(format!("{reason}: {detail}"))
            }
        })(),
        _ => unreachable!(),
    };
    match result {
        Ok(()) => Ok(refreshed_phase3_reply(actual_root, true)),
        Err(error) => {
            if let Some(detail) = error.strip_prefix("refreshFailedApplied: ") {
                Ok(mutation_failure("refreshFailed", detail, true))
            } else {
                Ok(phase3_error(error, false))
            }
        }
    }
}

fn has_untracked_integration_collision(
    repo_root: &str,
    expected_head_oid: &str,
    expected_upstream_oid: &str,
) -> Result<bool, String> {
    let changed = run_git(
        repo_root,
        &[
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            expected_head_oid,
            expected_upstream_oid,
            "--",
        ],
        STATUS_MAX_BYTES + 1,
    )?;
    if !changed.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect fast-forward paths: {}",
            stderr(&changed)
        ));
    }
    if changed.stdout.len() > STATUS_MAX_BYTES {
        return Err("gitUnavailable: fast-forward path review exceeded its safety limit".into());
    }
    let tracked = run_git(repo_root, &["ls-files", "-z"], STATUS_MAX_BYTES + 1)?;
    if !tracked.status.success() {
        return Err(format!(
            "gitUnavailable: cannot inspect tracked paths: {}",
            stderr(&tracked)
        ));
    }
    if tracked.stdout.len() > STATUS_MAX_BYTES {
        return Err("gitUnavailable: tracked path review exceeded its safety limit".into());
    }
    let decode_paths = |bytes: &[u8]| -> Result<Vec<String>, String> {
        std::str::from_utf8(bytes)
            .map_err(|_| "unsafeRepositoryConfiguration: non-UTF-8 repository paths cannot be integrated safely".to_owned())
            .map(|value| {
                value
                    .split('\0')
                    .filter(|path| !path.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
    };
    let tracked = decode_paths(&tracked.stdout)?
        .into_iter()
        .collect::<HashSet<_>>();
    for relative in decode_paths(&changed.stdout)? {
        if tracked.contains(&relative) {
            continue;
        }
        let candidate = Path::new(repo_root).join(&relative);
        if fs::symlink_metadata(&candidate).is_ok() {
            return Ok(true);
        }
        let mut ancestor = candidate.parent();
        while let Some(path) = ancestor {
            if path == Path::new(repo_root) {
                break;
            }
            if let Ok(metadata) = fs::symlink_metadata(path) {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Ok(true);
                }
            }
            ancestor = path.parent();
        }
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
fn repository_phase4_blocking(
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    expected_local_branch: String,
    expected_head_oid: String,
    expected_upstream_oid: String,
    expected_upstream_remote: String,
    expected_upstream_branch: String,
    expected_merge_base_oid: String,
    strategy: String,
) -> Result<RepositoryMutationReply, String> {
    let valid_oid = |value: &str| {
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let valid_name = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && value.trim() == value
            && !value.starts_with('-')
            && !value.chars().any(|ch| ch == '\0' || ch.is_control())
    };
    if operation != "integrateFastForward"
        || strategy != "fastForwardOnly"
        || !valid_name(&expected_local_branch)
        || !valid_oid(&expected_head_oid)
        || !valid_oid(&expected_upstream_oid)
        || !valid_name(&expected_upstream_remote)
        || !valid_name(&expected_upstream_branch)
        || !valid_oid(&expected_merge_base_oid)
    {
        return Ok(mutation_failure(
            "invalidRequest",
            "The Phase 4 repository payload is invalid for fast-forward integration.",
            false,
        ));
    }
    let (actual_root, before, metadata) =
        match validate_phase3_snapshot(&workspace_root, &repo_root, &generation) {
            Ok(value) => value,
            Err(error) => return Ok(phase3_error(error, false)),
        };
    if before.split('\0').any(|record| {
        record.starts_with("1 ")
            || record.starts_with("2 ")
            || record.starts_with("u ")
            || record.starts_with("? ")
    }) {
        return Ok(mutation_failure(
            "dirtyWorktree",
            "Fast-forward integration requires a clean index and worktree.",
            false,
        ));
    }
    if repository_operation(&actual_root).is_some() {
        return Ok(mutation_failure(
            "operationInProgress",
            "Finish the current Git operation before integrating.",
            false,
        ));
    }
    let git_directory = match git_dir(&actual_root) {
        Some(value) => value,
        None => {
            return Ok(mutation_failure(
                "gitUnavailable",
                "Git could not locate the repository metadata directory.",
                false,
            ))
        }
    };
    match fs::symlink_metadata(git_directory.join("index.lock")) {
        Ok(_) => {
            return Ok(mutation_failure(
                "indexLocked",
                "The repository index is locked by another Git process.",
                false,
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Ok(mutation_failure(
                "gitUnavailable",
                format!("Cannot inspect the repository index lock: {error}"),
                false,
            ))
        }
    }
    if !valid_branch_name(&actual_root, &expected_local_branch).unwrap_or(false)
        || !valid_remote_name(&actual_root, &expected_upstream_remote).unwrap_or(false)
        || !valid_branch_name(&actual_root, &expected_upstream_branch).unwrap_or(false)
    {
        return Ok(mutation_failure(
            "unsafeRepositoryConfiguration",
            "The reviewed branch or upstream cannot form a safe ref.",
            false,
        ));
    }
    let current_branch =
        match git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(Some(value)) => value,
            Ok(None) => {
                return Ok(mutation_failure(
                    "detachedHead",
                    "Fast-forward integration is unavailable from detached HEAD.",
                    false,
                ))
            }
            Err(error) => return Ok(phase3_error(error, false)),
        };
    let head = match git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"]) {
        Ok(Some(value)) => value,
        Ok(None) => {
            return Ok(mutation_failure(
                "detachedHead",
                "HEAD has no commit to integrate.",
                false,
            ))
        }
        Err(error) => return Ok(phase3_error(error, false)),
    };
    if current_branch != expected_local_branch || head != expected_head_oid {
        return Ok(mutation_failure(
            "staleGeneration",
            "The reviewed local branch or HEAD changed; refresh before integrating.",
            false,
        ));
    }
    if metadata.upstream_remote.as_deref() != Some(expected_upstream_remote.as_str())
        || metadata.upstream_branch.as_deref() != Some(expected_upstream_branch.as_str())
        || metadata.upstream_oid.as_deref() != Some(expected_upstream_oid.as_str())
        || metadata.merge_base_oid.as_deref() != Some(expected_merge_base_oid.as_str())
    {
        return Ok(mutation_failure(
            "staleGeneration",
            "The reviewed upstream or merge base changed; fetch and review again.",
            false,
        ));
    }
    if expected_head_oid == expected_upstream_oid {
        return Ok(mutation_failure(
            "nothingToIntegrate",
            "The local branch already matches its upstream.",
            false,
        ));
    }
    if expected_merge_base_oid != expected_head_oid {
        return Ok(mutation_failure(
            "nonFastForward",
            "The reviewed upstream cannot fast-forward the local branch.",
            false,
        ));
    }
    match has_untracked_integration_collision(
        &actual_root,
        &expected_head_oid,
        &expected_upstream_oid,
    ) {
        Ok(true) => {
            return Ok(mutation_failure(
                "dirtyWorktree",
                "An untracked or ignored path would be overwritten by integration.",
                false,
            ))
        }
        Ok(false) => {}
        Err(error) => return Ok(phase3_error(error, false)),
    }
    mutation_checkpoint("before-phase4-integrate", &actual_root);
    let hooks = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("gitUnavailable", error.to_string(), false)),
    };
    let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
    let output = match run_git(
        &actual_root,
        &[
            "-c",
            &hooks_config,
            "-c",
            "merge.autoStash=false",
            "-c",
            "submodule.recurse=false",
            "merge",
            "--ff-only",
            "--no-autostash",
            "--no-edit",
            "--no-stat",
            "--",
            &expected_upstream_oid,
        ],
        STATUS_MAX_BYTES,
    ) {
        Ok(value) => value,
        Err(error) => {
            let definitely_not_started = error
                .starts_with("gitUnavailable: Git executable was not found")
                || error.starts_with("gitUnavailable: cannot start Git:");
            if definitely_not_started {
                return Ok(phase3_error(error, false));
            }
            return Ok(mutation_failure(
                "refreshFailed",
                format!(
                    "Fast-forward integration may have changed the repository, but Git did not return a result: {error}"
                ),
                true,
            ));
        }
    };
    let final_branch =
        git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .flatten();
    let final_head = git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"])
        .ok()
        .flatten();
    if !output.status.success() {
        return Ok(mutation_failure(
            "refreshFailed",
            format!(
                "Fast-forward integration did not complete cleanly and may have changed the repository: {}",
                stderr(&output)
            ),
            true,
        ));
    }
    if final_branch.as_deref() != Some(expected_local_branch.as_str())
        || final_head.as_deref() != Some(expected_upstream_oid.as_str())
    {
        return Ok(mutation_failure(
            "refreshFailed",
            "Integration completed, but the checked-out branch no longer matches the reviewed result.",
            true,
        ));
    }
    Ok(refreshed_phase3_reply(actual_root, true))
}

fn repository_phase4b_blocking(
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    expected_local_branch: String,
    expected_head_oid: String,
    expected_upstream_oid: String,
    expected_upstream_remote: String,
    expected_upstream_branch: String,
    expected_merge_base_oid: String,
    strategy: String,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    let valid_oid = |value: &str| {
        matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
    };
    let valid_name = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && value.trim() == value
            && !value.starts_with('-')
            && !value.chars().any(|ch| ch == '\0' || ch.is_control())
    };
    let merge_message =
        match (operation.as_str(), strategy.as_str(), message) {
            ("integrateMerge", "mergeCommit", Some(value)) => {
                if value.trim().is_empty() {
                    return Ok(mutation_failure(
                        "emptyMessage",
                        "Enter a merge commit message.",
                        false,
                    ));
                }
                if value.trim() != value || value.len() > 4096 || value.contains('\0') {
                    return Ok(mutation_failure(
                        "invalidRequest",
                        "Merge message must be trimmed and no larger than 4096 UTF-8 bytes.",
                        false,
                    ));
                }
                Some(value)
            }
            ("integrateRebase", "rebaseLinear", None) => None,
            _ => return Ok(mutation_failure(
                "invalidRequest",
                "The Phase 4B repository payload does not match the selected integration strategy.",
                false,
            )),
        };
    if !valid_name(&expected_local_branch)
        || !valid_oid(&expected_head_oid)
        || !valid_oid(&expected_upstream_oid)
        || !valid_name(&expected_upstream_remote)
        || !valid_name(&expected_upstream_branch)
        || !valid_oid(&expected_merge_base_oid)
    {
        return Ok(mutation_failure(
            "invalidRequest",
            "The Phase 4B repository payload is invalid.",
            false,
        ));
    }

    let (actual_root, before, metadata) =
        match validate_phase3_snapshot(&workspace_root, &repo_root, &generation) {
            Ok(value) => value,
            Err(error) => return Ok(phase3_error(error, false)),
        };
    let has_changes = |porcelain: &str| {
        porcelain.split('\0').any(|record| {
            record.starts_with("1 ")
                || record.starts_with("2 ")
                || record.starts_with("u ")
                || record.starts_with("? ")
        })
    };
    if has_changes(&before) {
        return Ok(mutation_failure(
            "dirtyWorktree",
            "Merge and rebase require a clean index and worktree.",
            false,
        ));
    }
    if repository_operation(&actual_root).is_some() {
        return Ok(mutation_failure(
            "operationInProgress",
            "Finish the current Git operation before integrating.",
            false,
        ));
    }
    if let Err(error) = ensure_safe_phase4b_config(&actual_root) {
        return Ok(phase3_error(error, false));
    }
    let git_directory = match git_dir(&actual_root) {
        Some(value) => value,
        None => {
            return Ok(mutation_failure(
                "gitUnavailable",
                "Git could not locate the repository metadata directory.",
                false,
            ))
        }
    };
    match fs::symlink_metadata(git_directory.join("index.lock")) {
        Ok(_) => {
            return Ok(mutation_failure(
                "indexLocked",
                "The repository index is locked by another Git process.",
                false,
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Ok(mutation_failure(
                "gitUnavailable",
                format!("Cannot inspect the repository index lock: {error}"),
                false,
            ))
        }
    }
    if !valid_branch_name(&actual_root, &expected_local_branch).unwrap_or(false)
        || !valid_remote_name(&actual_root, &expected_upstream_remote).unwrap_or(false)
        || !valid_branch_name(&actual_root, &expected_upstream_branch).unwrap_or(false)
    {
        return Ok(mutation_failure(
            "unsafeRepositoryConfiguration",
            "The reviewed branch or upstream cannot form a safe ref.",
            false,
        ));
    }
    let current_branch =
        match git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(Some(value)) => value,
            Ok(None) => {
                return Ok(mutation_failure(
                    "detachedHead",
                    "Reviewed integration is unavailable from detached HEAD.",
                    false,
                ))
            }
            Err(error) => return Ok(phase3_error(error, false)),
        };
    let head = match git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"]) {
        Ok(Some(value)) => value,
        Ok(None) => {
            return Ok(mutation_failure(
                "detachedHead",
                "HEAD has no commit to integrate.",
                false,
            ))
        }
        Err(error) => return Ok(phase3_error(error, false)),
    };
    if current_branch != expected_local_branch || head != expected_head_oid {
        return Ok(mutation_failure(
            "staleGeneration",
            "The reviewed local branch or HEAD changed; refresh before integrating.",
            false,
        ));
    }
    if metadata.upstream_remote.as_deref() != Some(expected_upstream_remote.as_str())
        || metadata.upstream_branch.as_deref() != Some(expected_upstream_branch.as_str())
        || metadata.upstream_oid.as_deref() != Some(expected_upstream_oid.as_str())
        || metadata.merge_base_oid.as_deref() != Some(expected_merge_base_oid.as_str())
    {
        return Ok(mutation_failure(
            "staleGeneration",
            "The reviewed upstream or merge base changed; fetch and review again.",
            false,
        ));
    }
    if expected_head_oid == expected_upstream_oid
        || expected_merge_base_oid == expected_upstream_oid
    {
        return Ok(mutation_failure(
            "nothingToIntegrate",
            "The local branch already contains the reviewed upstream.",
            false,
        ));
    }
    if expected_merge_base_oid == expected_head_oid {
        return Ok(mutation_failure(
            "nonFastForward",
            "This reviewed history can be integrated with the safer fast-forward action.",
            false,
        ));
    }
    let local_commit_count =
        match revision_count(&actual_root, &expected_merge_base_oid, &expected_head_oid) {
            Ok(value) => value,
            Err(error) => return Ok(phase3_error(error, false)),
        };
    if operation == "integrateRebase" {
        if local_commit_count > PHASE4B_REBASE_MAX_COMMITS {
            return Ok(mutation_failure(
                "unsupportedHistory",
                format!(
                    "Linear rebase is limited to {PHASE4B_REBASE_MAX_COMMITS} reviewed local commits."
                ),
                false,
            ));
        }
        match local_range_has_merge(
            &actual_root,
            &expected_merge_base_oid,
            &expected_head_oid,
        ) {
            Ok(true) => {
                return Ok(mutation_failure(
                    "unsupportedHistory",
                    "The reviewed local range contains merge commits; preserve-merges rebase is not supported.",
                    false,
                ))
            }
            Ok(false) => {}
            Err(error) => return Ok(phase3_error(error, false)),
        }
    }
    match has_phase4b_untracked_collision(
        &actual_root,
        &expected_merge_base_oid,
        &expected_head_oid,
        &expected_upstream_oid,
    ) {
        Ok(true) => {
            return Ok(mutation_failure(
                "dirtyWorktree",
                "An untracked or ignored path may be overwritten during integration.",
                false,
            ))
        }
        Ok(false) => {}
        Err(error) => return Ok(phase3_error(error, false)),
    }
    let reviewed_other_refs = match unrelated_branch_refs(&actual_root, &expected_local_branch) {
        Ok(value) => value,
        Err(error) => return Ok(phase3_error(error, false)),
    };
    let identity = match read_effective_git_identity(&actual_root) {
        Ok(value) => value,
        Err(error) => return Ok(phase3_error(error, false)),
    };

    mutation_checkpoint("before-phase4b-integrate", &actual_root);
    let hooks = match tempfile::tempdir() {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("gitUnavailable", error.to_string(), false)),
    };
    let hooks_config = format!("core.hooksPath={}", hooks.path().to_string_lossy());
    let output = if operation == "integrateMerge" {
        run_git_with_index_and_identity(
            &actual_root,
            &[
                "-c",
                &hooks_config,
                "-c",
                "commit.gpgSign=false",
                "-c",
                "merge.verifySignatures=false",
                "-c",
                "merge.autoStash=false",
                "-c",
                "rebase.autoStash=false",
                "-c",
                "rebase.updateRefs=false",
                "-c",
                "rerere.enabled=false",
                "-c",
                "rerere.autoupdate=false",
                "-c",
                "submodule.recurse=false",
                "merge",
                "--no-ff",
                "--no-autostash",
                "--no-edit",
                "--no-verify",
                "--no-gpg-sign",
                "--no-stat",
                "--cleanup=verbatim",
                "--strategy=ort",
                "-m",
                merge_message.as_deref().expect("validated merge message"),
                "--",
                &expected_upstream_oid,
            ],
            STATUS_MAX_BYTES,
            None,
            &identity,
            GitIdentityRole::AuthorAndCommitter,
        )
    } else {
        run_git_with_index_and_identity(
            &actual_root,
            &[
                "-c",
                &hooks_config,
                "-c",
                "commit.gpgSign=false",
                "-c",
                "merge.verifySignatures=false",
                "-c",
                "merge.autoStash=false",
                "-c",
                "rebase.autoStash=false",
                "-c",
                "rebase.updateRefs=false",
                "-c",
                "rerere.enabled=false",
                "-c",
                "rerere.autoupdate=false",
                "-c",
                "submodule.recurse=false",
                "rebase",
                "--merge",
                "--no-autostash",
                "--no-fork-point",
                "--no-rerere-autoupdate",
                "--no-update-refs",
                "--no-rebase-merges",
                "--reapply-cherry-picks",
                "--empty=keep",
                "--strategy=ort",
                "--onto",
                &expected_upstream_oid,
                &expected_merge_base_oid,
            ],
            STATUS_MAX_BYTES,
            None,
            &identity,
            GitIdentityRole::CommitterOnly,
        )
    };
    let output = match output {
        Ok(value) => value,
        Err(error) => {
            let definitely_not_started = error
                .starts_with("gitUnavailable: Git executable was not found")
                || error.starts_with("gitUnavailable: cannot start Git:");
            if definitely_not_started {
                return Ok(phase3_error(error, false));
            }
            return Ok(mutation_failure(
                "refreshFailed",
                format!(
                    "Reviewed integration may have changed the repository, but Git did not return a result: {error}"
                ),
                true,
            ));
        }
    };

    if !output.status.success() {
        let expected_operation = if operation == "integrateMerge" {
            "merge"
        } else {
            "rebase"
        };
        if repository_operation(&actual_root).as_deref() != Some(expected_operation) {
            return Ok(mutation_failure(
                "refreshFailed",
                format!(
                    "Reviewed integration did not complete and its repository state is ambiguous: {}",
                    stderr(&output)
                ),
                true,
            ));
        }
        let abort = if operation == "integrateMerge" {
            run_git(
                &actual_root,
                &[
                    "-c",
                    &hooks_config,
                    "-c",
                    "rerere.enabled=false",
                    "-c",
                    "rerere.autoupdate=false",
                    "-c",
                    "submodule.recurse=false",
                    "merge",
                    "--abort",
                ],
                STATUS_MAX_BYTES,
            )
        } else {
            run_git(
                &actual_root,
                &[
                    "-c",
                    &hooks_config,
                    "-c",
                    "rerere.enabled=false",
                    "-c",
                    "rerere.autoupdate=false",
                    "-c",
                    "submodule.recurse=false",
                    "rebase",
                    "--abort",
                ],
                STATUS_MAX_BYTES,
            )
        };
        let abort = match abort {
            Ok(value) if value.status.success() => value,
            Ok(value) => {
                return Ok(mutation_failure(
                    "refreshFailed",
                    format!(
                        "Git could not abort the incomplete integration: {}",
                        stderr(&value)
                    ),
                    true,
                ))
            }
            Err(error) => {
                return Ok(mutation_failure(
                    "refreshFailed",
                    format!("Git could not verify an integration abort: {error}"),
                    true,
                ))
            }
        };
        drop(abort);
        let restored_branch =
            git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"]);
        let restored_head = git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"]);
        let restored_status = status_porcelain(&actual_root);
        let restored_refs = unrelated_branch_refs(&actual_root, &expected_local_branch);
        let lock_absent = matches!(
            fs::symlink_metadata(git_directory.join("index.lock")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        );
        let restored = matches!(restored_branch, Ok(Some(ref value)) if value == &expected_local_branch)
            && matches!(restored_head, Ok(Some(ref value)) if value == &expected_head_oid)
            && matches!(restored_status, Ok(ref value) if !has_changes(&String::from_utf8_lossy(value)))
            && matches!(restored_refs, Ok(ref value) if value == &reviewed_other_refs)
            && repository_operation(&actual_root).is_none()
            && lock_absent;
        if !restored {
            return Ok(mutation_failure(
                "refreshFailed",
                "The incomplete integration was aborted, but restoration could not be verified.",
                true,
            ));
        }
        return Ok(mutation_failure(
            "integrationConflict",
            "Git found conflicts. The incomplete integration was aborted and the reviewed branch was restored.",
            false,
        ));
    }

    let final_branch =
        match git_stdout_optional(&actual_root, &["symbolic-ref", "--short", "-q", "HEAD"]) {
            Ok(Some(value)) => value,
            _ => {
                return Ok(mutation_failure(
                    "refreshFailed",
                    "Integration completed, but the checked-out branch could not be verified.",
                    true,
                ))
            }
        };
    let final_head = match git_stdout_optional(&actual_root, &["rev-parse", "--verify", "HEAD"]) {
        Ok(Some(value)) => value,
        _ => {
            return Ok(mutation_failure(
                "refreshFailed",
                "Integration completed, but the resulting HEAD could not be verified.",
                true,
            ))
        }
    };
    let final_status = match status_porcelain(&actual_root) {
        Ok(value) => String::from_utf8_lossy(&value).into_owned(),
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
    let final_refs = match unrelated_branch_refs(&actual_root, &expected_local_branch) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
    let final_metadata = match repository_metadata(&actual_root) {
        Ok(value) => value,
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    };
    let final_lock_absent = matches!(
        fs::symlink_metadata(git_directory.join("index.lock")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    if final_branch != expected_local_branch
        || has_changes(&final_status)
        || repository_operation(&actual_root).is_some()
        || !final_lock_absent
        || final_refs != reviewed_other_refs
        || final_metadata.upstream_remote.as_deref() != Some(expected_upstream_remote.as_str())
        || final_metadata.upstream_branch.as_deref() != Some(expected_upstream_branch.as_str())
        || final_metadata.upstream_oid.as_deref() != Some(expected_upstream_oid.as_str())
        || final_metadata.merge_base_oid.as_deref() != Some(expected_upstream_oid.as_str())
    {
        return Ok(mutation_failure(
            "refreshFailed",
            "Integration completed, but the reviewed repository invariants could not be verified.",
            true,
        ));
    }

    if operation == "integrateMerge" {
        let parents = match git_stdout_optional(
            &actual_root,
            &["rev-list", "--parents", "-n", "1", &final_head],
        ) {
            Ok(Some(value)) => value,
            _ => {
                return Ok(mutation_failure(
                    "refreshFailed",
                    "The merge commit parent graph could not be verified.",
                    true,
                ))
            }
        };
        let parents = parents.split_whitespace().collect::<Vec<_>>();
        if parents.len() != 3
            || parents[0] != final_head
            || parents[1] != expected_head_oid
            || parents[2] != expected_upstream_oid
        {
            return Ok(mutation_failure(
                "refreshFailed",
                "The merge result does not have the exact reviewed parent graph.",
                true,
            ));
        }
        let final_message =
            match git_stdout_optional(&actual_root, &["log", "-1", "--format=%B", &final_head]) {
                Ok(Some(value)) => value,
                _ => {
                    return Ok(mutation_failure(
                        "refreshFailed",
                        "The reviewed merge commit message could not be verified.",
                        true,
                    ))
                }
            };
        if final_message != merge_message.as_deref().expect("validated merge message") {
            return Ok(mutation_failure(
                "refreshFailed",
                "The merge result does not preserve the reviewed commit message.",
                true,
            ));
        }
    } else {
        let rebased_count = match revision_count(&actual_root, &expected_upstream_oid, &final_head)
        {
            Ok(value) => value,
            Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
        };
        if rebased_count != local_commit_count {
            return Ok(mutation_failure(
                "refreshFailed",
                "The rebase result did not preserve the reviewed local commit count.",
                true,
            ));
        }
        match local_range_has_merge(&actual_root, &expected_upstream_oid, &final_head) {
            Ok(false) => {}
            Ok(true) => {
                return Ok(mutation_failure(
                    "refreshFailed",
                    "The rebase result unexpectedly contains merge commits.",
                    true,
                ))
            }
            Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
        }
    }
    match is_ancestor(&actual_root, &expected_upstream_oid, &final_head) {
        Ok(true) => {}
        Ok(false) => {
            return Ok(mutation_failure(
                "refreshFailed",
                "The reviewed upstream is not an ancestor of the integration result.",
                true,
            ))
        }
        Err(error) => return Ok(mutation_failure("refreshFailed", error, true)),
    }
    Ok(refreshed_phase3_reply(actual_root, true))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn repository_phase4b(
    state: State<'_, PiProc>,
    target_id: String,
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    expected_local_branch: String,
    expected_head_oid: String,
    expected_upstream_oid: String,
    expected_upstream_remote: String,
    expected_upstream_branch: String,
    expected_merge_base_oid: String,
    strategy: String,
    message: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if let Err(reply) = require_local_repository_target(&target_id) {
        return Ok(reply);
    }
    let _write_guard = match state.begin_repository_write(&target_id, &workspace_root) {
        Ok(guard) => guard,
        Err(detail) => return Ok(mutation_failure("piBusy", detail, false)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repository_phase4b_blocking(
            workspace_root,
            repo_root,
            generation,
            operation,
            expected_local_branch,
            expected_head_oid,
            expected_upstream_oid,
            expected_upstream_remote,
            expected_upstream_branch,
            expected_merge_base_oid,
            strategy,
            message,
        )
    })
    .await
    .map_err(|error| format!("repository Phase 4B task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn repository_phase4(
    state: State<'_, PiProc>,
    target_id: String,
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    expected_local_branch: String,
    expected_head_oid: String,
    expected_upstream_oid: String,
    expected_upstream_remote: String,
    expected_upstream_branch: String,
    expected_merge_base_oid: String,
    strategy: String,
) -> Result<RepositoryMutationReply, String> {
    if let Err(reply) = require_local_repository_target(&target_id) {
        return Ok(reply);
    }
    let _write_guard = match state.begin_repository_write(&target_id, &workspace_root) {
        Ok(guard) => guard,
        Err(detail) => return Ok(mutation_failure("piBusy", detail, false)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repository_phase4_blocking(
            workspace_root,
            repo_root,
            generation,
            operation,
            expected_local_branch,
            expected_head_oid,
            expected_upstream_oid,
            expected_upstream_remote,
            expected_upstream_branch,
            expected_merge_base_oid,
            strategy,
        )
    })
    .await
    .map_err(|error| format!("repository Phase 4 task failed: {error}"))?
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn repository_phase3(
    state: State<'_, PiProc>,
    target_id: String,
    workspace_root: String,
    repo_root: String,
    generation: String,
    operation: String,
    remote: Option<String>,
    expected_head_oid: Option<String>,
    expected_upstream_oid: Option<String>,
    expected_upstream_remote: Option<String>,
    expected_upstream_branch: Option<String>,
    branch_name: Option<String>,
) -> Result<RepositoryMutationReply, String> {
    if let Err(reply) = require_local_repository_target(&target_id) {
        return Ok(reply);
    }
    if operation == "stagedDiff" {
        return tauri::async_runtime::spawn_blocking(move || {
            repository_phase3_blocking(
                workspace_root,
                repo_root,
                generation,
                operation,
                remote,
                expected_head_oid,
                expected_upstream_oid,
                expected_upstream_remote,
                expected_upstream_branch,
                branch_name,
            )
        })
        .await
        .map_err(|error| format!("repository Phase 3 task failed: {error}"))?;
    }
    let _write_guard = match state.begin_repository_write(&target_id, &workspace_root) {
        Ok(guard) => guard,
        Err(detail) => return Ok(mutation_failure("piBusy", detail, false)),
    };
    tauri::async_runtime::spawn_blocking(move || {
        repository_phase3_blocking(
            workspace_root,
            repo_root,
            generation,
            operation,
            remote,
            expected_head_oid,
            expected_upstream_oid,
            expected_upstream_remote,
            expected_upstream_branch,
            branch_name,
        )
    })
    .await
    .map_err(|error| format!("repository Phase 3 task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::unix_path_is_secure;
    #[cfg(windows)]
    use super::windows_system_directory;
    use super::{
        credential_helper_command, discover_repo_root, ensure_safe_phase4b_config,
        ensure_safe_sync_config, http_remote_url_is_safe, parse_git_identity,
        parse_trusted_credential_helpers, parse_trusted_http_proxy, remote_authentication_failed,
        repository_generation, repository_metadata, repository_mutate_blocking,
        repository_mutate_blocking_with_files, repository_operation, repository_phase3_blocking,
        repository_phase4_blocking, repository_phase4b_blocking, require_local_repository_target,
        run_git_with_trusted_http_transport, set_mutation_test_hook, status_porcelain,
        trusted_http_transport, worktree_fingerprint, RepositoryMutationFile,
        TrustedCredentialHelperKind, TrustedHttpTransport,
    };
    use std::fs;
    use std::path::Path;
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

    struct DivergedFixture {
        directory: tempfile::TempDir,
        local_branch: String,
        local_head: String,
        upstream: String,
    }

    fn init_diverged_repo(conflict: bool) -> DivergedFixture {
        let directory = init_repo();
        git(directory.path(), &["config", "core.autocrlf", "false"]);
        fs::write(directory.path().join("shared.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "shared.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        let local_branch = git_stdout(directory.path(), &["branch", "--show-current"])
            .trim()
            .to_owned();
        let base = git_stdout(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();

        git(
            directory.path(),
            &["switch", "-q", "-c", "reviewed-upstream"],
        );
        if conflict {
            fs::write(directory.path().join("shared.txt"), "upstream\n")
                .expect("write upstream conflict");
            git(directory.path(), &["add", "shared.txt"]);
        } else {
            fs::write(directory.path().join("upstream.txt"), "upstream\n")
                .expect("write upstream file");
            git(directory.path(), &["add", "upstream.txt"]);
        }
        git(directory.path(), &["commit", "-q", "-m", "upstream"]);
        let upstream = git_stdout(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();

        git(directory.path(), &["switch", "-q", &local_branch]);
        if conflict {
            fs::write(directory.path().join("shared.txt"), "local\n")
                .expect("write local conflict");
            git(directory.path(), &["add", "shared.txt"]);
        } else {
            fs::write(directory.path().join("local.txt"), "local\n").expect("write local file");
            git(directory.path(), &["add", "local.txt"]);
        }
        git(directory.path(), &["commit", "-q", "-m", "local"]);
        let local_head = git_stdout(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        git(directory.path(), &["branch", "preserved", &base]);
        git(directory.path(), &["remote", "add", "origin", "."]);
        git(
            directory.path(),
            &["update-ref", "refs/remotes/origin/main", &upstream],
        );
        git(
            directory.path(),
            &["config", &format!("branch.{local_branch}.remote"), "origin"],
        );
        git(
            directory.path(),
            &[
                "config",
                &format!("branch.{local_branch}.merge"),
                "refs/heads/main",
            ],
        );

        DivergedFixture {
            directory,
            local_branch,
            local_head,
            upstream,
        }
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
    fn batch_stage_and_unstage_mutate_only_the_exact_reviewed_set() {
        let directory = init_repo();
        fs::write(directory.path().join("tracked.txt"), "base\n").expect("write tracked file");
        git(directory.path(), &["add", "tracked.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        fs::write(directory.path().join("tracked.txt"), "changed\n").expect("edit tracked file");
        fs::write(directory.path().join("new.txt"), "new\n").expect("write reviewed file");
        fs::write(directory.path().join("left-alone.txt"), "other\n")
            .expect("write unrelated file");
        let (repo_root, generation) = root_and_generation(directory.path());
        let workspace = directory.path().to_string_lossy().into_owned();
        let files = vec![
            RepositoryMutationFile {
                path: "tracked.txt".into(),
                original_path: None,
            },
            RepositoryMutationFile {
                path: "new.txt".into(),
                original_path: None,
            },
        ];
        let staged = repository_mutate_blocking_with_files(
            workspace.clone(),
            repo_root.clone(),
            generation,
            "stageBatch".into(),
            None,
            None,
            Some(files.clone()),
            None,
        )
        .expect("batch stage");
        assert!(staged.ok, "{:?}", staged.detail);
        assert_eq!(
            git_stdout(directory.path(), &["diff", "--cached", "--name-only"]),
            "new.txt\ntracked.txt\n"
        );
        assert!(staged
            .porcelain
            .as_deref()
            .unwrap_or_default()
            .contains("left-alone.txt"));

        let unstaged = repository_mutate_blocking_with_files(
            workspace,
            repo_root,
            staged.generation.expect("stage generation"),
            "unstageBatch".into(),
            None,
            None,
            Some(files),
            None,
        )
        .expect("batch unstage");
        assert!(unstaged.ok, "{:?}", unstaged.detail);
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());
    }

    #[test]
    fn batch_stage_rejects_worktree_drift_before_installing_the_index() {
        let directory = init_repo();
        git(directory.path(), &["config", "core.autocrlf", "false"]);
        fs::write(directory.path().join("reviewed.txt"), "reviewed\n").expect("write fixture");
        let (repo_root, generation) = root_and_generation(directory.path());
        let target = repo_root.clone();
        let mut changed = false;
        set_mutation_test_hook(Some(Box::new(move |checkpoint, root| {
            if !changed && checkpoint == "after-index-lock" && root == target {
                fs::write(Path::new(root).join("reviewed.txt"), "raced\n")
                    .expect("race reviewed worktree file");
                changed = true;
            }
        })));
        let reply = repository_mutate_blocking_with_files(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "stageBatch".into(),
            None,
            None,
            Some(vec![RepositoryMutationFile {
                path: "reviewed.txt".into(),
                original_path: None,
            }]),
            None,
        )
        .expect("raced batch reply");
        set_mutation_test_hook(None);
        assert!(!reply.ok);
        assert!(!reply.applied);
        assert_eq!(reply.reason.as_deref(), Some("staleGeneration"));
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());
        assert_eq!(
            fs::read_to_string(directory.path().join("reviewed.txt")).unwrap(),
            "raced\n"
        );
    }

    #[test]
    fn batch_mutation_rejects_duplicate_reviewed_paths_before_mutating() {
        let directory = init_repo();
        fs::write(directory.path().join("new.txt"), "new\n").expect("write file");
        let (repo_root, generation) = root_and_generation(directory.path());
        let reply = repository_mutate_blocking_with_files(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "stageBatch".into(),
            None,
            None,
            Some(vec![
                RepositoryMutationFile {
                    path: "new.txt".into(),
                    original_path: None,
                },
                RepositoryMutationFile {
                    path: "new.txt".into(),
                    original_path: None,
                },
            ]),
            None,
        )
        .expect("duplicate batch reply");
        assert!(!reply.ok);
        assert_eq!(reply.reason.as_deref(), Some("invalidRequest"));
        assert!(!reply.applied);
        assert!(git_stdout(directory.path(), &["diff", "--cached", "--name-only"]).is_empty());
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
    fn reviewed_commit_uses_the_identity_captured_before_isolated_mutation() {
        let directory = init_repo();
        fs::write(directory.path().join("reviewed.txt"), "reviewed\n").expect("write fixture");
        git(directory.path(), &["add", "reviewed.txt"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let target = repo_root.clone();
        let mut removed = false;
        set_mutation_test_hook(Some(Box::new(move |checkpoint, root| {
            if !removed && checkpoint == "after-identity-resolution" && root == target {
                git(Path::new(root), &["config", "--unset", "user.name"]);
                git(Path::new(root), &["config", "--unset", "user.email"]);
                removed = true;
            }
        })));
        let reply = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "commit".into(),
            None,
            None,
            Some("captured identity".into()),
        )
        .expect("commit reply");
        set_mutation_test_hook(None);
        assert!(reply.ok, "{:?}", reply.detail);
        assert!(reply.applied);
        assert_eq!(
            git_stdout(
                directory.path(),
                &["show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"],
            ),
            "Repository Test\0test@example.com\0Repository Test\0test@example.com\n"
        );
    }

    #[test]
    fn reviewed_commit_reports_identity_unavailable_before_writing_objects_or_refs() {
        let directory = init_repo();
        fs::write(directory.path().join("base.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "base.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        fs::write(directory.path().join("reviewed.txt"), "reviewed\n").expect("write fixture");
        git(directory.path(), &["add", "reviewed.txt"]);
        git(directory.path(), &["config", "user.name", ""]);
        git(directory.path(), &["config", "user.email", ""]);
        git(directory.path(), &["config", "user.useConfigOnly", "true"]);
        let old_head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        let old_index = git_stdout(directory.path(), &["diff", "--cached", "--binary"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let reply = repository_mutate_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "commit".into(),
            None,
            None,
            Some("must not commit".into()),
        )
        .expect("identity failure reply");
        assert!(!reply.ok);
        assert!(!reply.applied);
        assert_eq!(reply.reason.as_deref(), Some("identityUnavailable"));
        assert_eq!(
            git_stdout(directory.path(), &["rev-parse", "HEAD"]),
            old_head
        );
        assert_eq!(
            git_stdout(directory.path(), &["diff", "--cached", "--binary"]),
            old_index
        );
    }

    #[test]
    fn git_identity_parser_is_strict_and_preserves_spaced_unicode_names() {
        assert_eq!(
            parse_git_identity("测试 User <user@example.com> 1700000000 +0800\n".as_bytes())
                .expect("valid identity"),
            super::GitIdentity {
                name: "测试 User".into(),
                email: "user@example.com".into(),
            }
        );
        for invalid in [
            b"".as_slice(),
            b"User <user@example.com> 1 +0000\nextra\n".as_slice(),
            b" User <user@example.com> 1 +0000\n".as_slice(),
            b"User <user@example.com > 1 +0000\n".as_slice(),
            b"User <user@example.com> invalid +0000\n".as_slice(),
            b"User <> 1 +0000\n".as_slice(),
            b"User\0 <user@example.com> 1 +0000\n".as_slice(),
            &[0xff, 0xfe],
        ] {
            assert!(parse_git_identity(invalid).is_err());
        }
        assert!(parse_git_identity(&vec![b'a'; 1025]).is_err());
    }

    #[test]
    fn credential_helper_command_binds_and_quotes_the_reviewed_absolute_path() {
        let command = credential_helper_command(Path::new("/trusted/manager's helper"))
            .expect("credential helper command");
        assert_eq!(command, "!'/trusted/manager'\\''s helper'");
        assert!(credential_helper_command(Path::new("bad\npath")).is_err());
    }

    #[test]
    fn credential_helper_parser_accepts_only_one_exact_gcm_after_the_last_reset() {
        let mut manager = None;
        parse_trusted_credential_helpers(b"manager\0", &mut manager).expect("manager");
        assert_eq!(manager, Some(TrustedCredentialHelperKind::Manager));

        let mut manager_core = None;
        parse_trusted_credential_helpers(b"manager-core\0", &mut manager_core)
            .expect("manager-core");
        assert_eq!(manager_core, Some(TrustedCredentialHelperKind::ManagerCore));

        let mut reset = None;
        parse_trusted_credential_helpers(b"manager\0\0manager-core\0", &mut reset)
            .expect("reset helper chain");
        assert_eq!(reset, Some(TrustedCredentialHelperKind::ManagerCore));

        for invalid in [
            b"!command\0".as_slice(),
            b"/usr/bin/git-credential-manager\0".as_slice(),
            b"manager --argument\0".as_slice(),
            b"store\0".as_slice(),
            b" manager\0".as_slice(),
            b"manager".as_slice(),
            b"manager\0manager-core\0".as_slice(),
            &[0xff, 0x00],
        ] {
            assert!(parse_trusted_credential_helpers(invalid, &mut None).is_err());
        }
        assert!(parse_trusted_credential_helpers(&vec![b'a'; 4097], &mut None).is_err());
    }
    #[test]
    fn trusted_http_proxy_parser_accepts_only_bounded_anonymous_http_urls() {
        assert_eq!(
            parse_trusted_http_proxy(b"http://127.0.0.1:10808\0").expect("HTTP proxy"),
            "http://127.0.0.1:10808"
        );
        assert_eq!(
            parse_trusted_http_proxy(b"https://proxy.example.test/path\0").expect("HTTPS proxy"),
            "https://proxy.example.test/path"
        );
        assert_eq!(parse_trusted_http_proxy(b"\0").expect("disabled proxy"), "");

        for invalid in [
            b"http://user:password@proxy.example.test\0".as_slice(),
            b"http://@proxy.example.test\0".as_slice(),
            b"socks5://proxy.example.test:1080\0".as_slice(),
            b"http://proxy.example.test?token=secret\0".as_slice(),
            b"http://proxy.example.test#fragment\0".as_slice(),
            b"http:///missing-host\0".as_slice(),
            b" http://proxy.example.test\0".as_slice(),
            b"http://proxy.example.test\n\0".as_slice(),
            b"http://proxy.example.test\\path\0".as_slice(),
            b"http://proxy.example.test\0extra\0".as_slice(),
            b"http://proxy.example.test".as_slice(),
            &[0xff, 0x00],
        ] {
            assert!(parse_trusted_http_proxy(invalid).is_err());
        }
        assert!(parse_trusted_http_proxy(&vec![b'a'; 4097]).is_err());
    }

    #[test]
    fn trusted_http_runner_resets_helpers_and_injects_only_the_trusted_proxy() {
        let directory = init_repo();
        let transport = TrustedHttpTransport {
            git_executable: std::path::PathBuf::from("git"),
            credential_helper: Some(std::path::PathBuf::from("/trusted/git-credential-manager")),
            path_environment: std::env::var_os("PATH").unwrap_or_default(),
            http_proxy: Some("http://127.0.0.1:10808".to_owned()),
        };
        let root = directory.path().to_string_lossy();
        let helpers = run_git_with_trusted_http_transport(
            &root,
            &["config", "--get-all", "credential.helper"],
            1024,
            &transport,
        )
        .expect("inspect credential helper configuration");
        assert!(helpers.status.success());
        assert_eq!(helpers.stdout, b"\n!'/trusted/git-credential-manager'\n");

        let interaction = run_git_with_trusted_http_transport(
            &root,
            &["config", "--get", "credential.interactive"],
            1024,
            &transport,
        )
        .expect("inspect credential interaction configuration");
        assert!(interaction.status.success());
        assert_eq!(interaction.stdout, b"never\n");

        let proxy = run_git_with_trusted_http_transport(
            &root,
            &["config", "--get", "http.proxy"],
            1024,
            &transport,
        )
        .expect("inspect trusted proxy configuration");
        assert!(proxy.status.success());
        assert_eq!(proxy.stdout, b"http://127.0.0.1:10808\n");

        let http_transport = TrustedHttpTransport {
            credential_helper: None,
            http_proxy: Some(String::new()),
            ..transport
        };
        let disabled_proxy = run_git_with_trusted_http_transport(
            &root,
            &["config", "--get", "http.proxy"],
            1024,
            &http_transport,
        )
        .expect("inspect explicitly disabled trusted proxy");
        assert!(disabled_proxy.status.success());
        assert_eq!(disabled_proxy.stdout, b"\n");
        let helpers = run_git_with_trusted_http_transport(
            &root,
            &["config", "--get-all", "credential.helper"],
            1024,
            &http_transport,
        )
        .expect("inspect HTTP credential helper isolation");
        assert_eq!(helpers.status.code(), Some(1));
        assert!(helpers.stdout.is_empty());
    }

    #[test]
    fn trusted_sync_preflight_never_executes_path_git() {
        const CHILD_FLAG: &str = "PI_REPOSITORY_TRUSTED_GIT_CHILD";
        const REPO_ENV: &str = "PI_REPOSITORY_TRUSTED_GIT_REPO";
        const MARKER_ENV: &str = "PI_REPOSITORY_TRUSTED_GIT_MARKER";

        if std::env::var_os(CHILD_FLAG).is_some() {
            let repo = std::env::var(REPO_ENV).expect("child repository path");
            let marker =
                std::path::PathBuf::from(std::env::var_os(MARKER_ENV).expect("child marker path"));
            let (fetch_url, _, git_executable) =
                ensure_safe_sync_config(&repo, "origin").expect("trusted sync preflight");
            let _ = trusted_http_transport(&repo, &fetch_url, git_executable);
            assert!(
                !marker.exists(),
                "PATH-resolved Git inspected trusted transport configuration"
            );
            return;
        }

        let directory = init_repo();
        git(
            directory.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/org/repo.git",
            ],
        );
        let fake_bin = directory.path().join("hostile-bin");
        fs::create_dir(&fake_bin).expect("create hostile PATH directory");
        let marker = directory.path().join("path-git-ran");

        #[cfg(windows)]
        fs::write(
            fake_bin.join("git.cmd"),
            format!(
                "@echo off\r\ntype nul > \"{}\"\r\nexit /b 97\r\n",
                marker.display()
            ),
        )
        .expect("write hostile Git wrapper");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let wrapper = fake_bin.join("git");
            let escaped_marker = marker.to_string_lossy().replace('\'', "'\\''");
            fs::write(
                &wrapper,
                format!("#!/bin/sh\ntouch '{escaped_marker}'\nexit 97\n"),
            )
            .expect("write hostile Git wrapper");
            let mut permissions = fs::metadata(&wrapper)
                .expect("inspect hostile Git wrapper")
                .permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&wrapper, permissions).expect("make hostile Git executable");
        }

        let output = Command::new(std::env::current_exe().expect("current test executable"))
            .args([
                "--exact",
                "repository::tests::trusted_sync_preflight_never_executes_path_git",
                "--nocapture",
            ])
            .env(CHILD_FLAG, "1")
            .env(REPO_ENV, directory.path())
            .env(MARKER_ENV, &marker)
            .env("PATH", &fake_bin)
            .output()
            .expect("run isolated trusted Git preflight test");
        assert!(
            output.status.success(),
            "child preflight failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!marker.exists(), "PATH-resolved Git was executed");
    }

    #[test]
    fn http_remote_urls_reject_embedded_credentials_queries_and_fragments() {
        assert!(http_remote_url_is_safe("https://example.com/org/repo.git"));
        assert!(http_remote_url_is_safe("http://example.com/org/repo.git"));
        assert!(http_remote_url_is_safe("git@example.com:org/repo.git"));
        for unsafe_url in [
            "https://user:token@example.com/org/repo.git",
            "https://token@example.com/org/repo.git",
            "https://@example.com/org/repo.git",
            "https://example.com/org/repo.git?token=secret",
            "https://example.com/org/repo.git#secret",
            "https:///org/repo.git",
            r"https://example.com\org\repo.git",
            r"https://example.com\@attacker.invalid/org/repo.git",
            "https://example.com/org/repo.git\nsecond",
            "https://example.com/error: 403/repo.git",
        ] {
            assert!(
                !http_remote_url_is_safe(unsafe_url),
                "accepted {unsafe_url:?}"
            );
        }
    }
    #[cfg(windows)]
    #[test]
    fn credential_path_uses_the_os_reported_windows_system_directory() {
        let directory = windows_system_directory().expect("resolve the Windows system directory");
        assert!(directory.is_absolute());
        assert!(directory.is_dir());
        assert_ne!(
            directory,
            std::path::PathBuf::from(r"Z:\hostile-system-root\System32")
        );
    }

    #[cfg(unix)]
    #[test]
    fn credential_path_rejects_non_root_owned_posix_executables() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let directory = tempfile::tempdir().expect("create temporary directory");
        if fs::metadata(directory.path())
            .expect("inspect temporary directory")
            .uid()
            == 0
        {
            return;
        }
        let executable = directory.path().join("git-credential-manager");
        fs::write(&executable, "#!/bin/sh\nexit 0\n").expect("write fake helper");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755))
            .expect("make fake helper executable");
        assert!(!unix_path_is_secure(&executable, true));
    }

    #[test]
    fn https_authentication_classifier_recognizes_authorization_failures_only_by_content() {
        for detail in [
            "fatal: Authentication failed",
            "fatal: unable to access 'https://example.test/repo': The requested URL returned error: 401",
            "fatal: unable to access 'https://example.test/repo': The requested URL returned error: 403",
        ] {
            assert!(remote_authentication_failed(detail), "missed {detail:?}");
        }
        for detail in [
            "Could not resolve host",
            "Connection timed out",
            "Could not resolve host: forbidden.example",
            "Could not resolve host while reading https://example.test/credential-manager/repo",
            "Could not resolve host while reading https://example.test/http%20401/error:%20403",
            "remote: policy validation: authentication failed marker",
            "remote: terminal prompts disabled by repository policy",
            "remote: 403 forbidden marker in hook output",
        ] {
            assert!(
                !remote_authentication_failed(detail),
                "misclassified {detail:?}"
            );
        }
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

    #[test]
    fn phase4_integrates_only_the_reviewed_fast_forward_without_hooks() {
        let directory = init_repo();
        git(directory.path(), &["config", "core.autocrlf", "false"]);
        fs::write(directory.path().join("file.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        let local_branch = git_stdout(directory.path(), &["branch", "--show-current"])
            .trim()
            .to_owned();
        let base = git_stdout(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        git(
            directory.path(),
            &["switch", "-q", "-c", "reviewed-upstream"],
        );
        fs::write(directory.path().join("file.txt"), "upstream\n").expect("write upstream");
        fs::write(
            directory.path().join("generated.txt"),
            "upstream generated\n",
        )
        .expect("write upstream generated file");
        git(directory.path(), &["add", "file.txt", "generated.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "upstream"]);
        let upstream = git_stdout(directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        git(directory.path(), &["switch", "-q", &local_branch]);
        git(directory.path(), &["remote", "add", "origin", "."]);
        git(
            directory.path(),
            &["update-ref", "refs/remotes/origin/main", &upstream],
        );
        git(
            directory.path(),
            &["config", &format!("branch.{local_branch}.remote"), "origin"],
        );
        git(
            directory.path(),
            &[
                "config",
                &format!("branch.{local_branch}.merge"),
                "refs/heads/main",
            ],
        );
        let hook = directory.path().join(".git/hooks/post-merge");
        fs::write(&hook, "#!/bin/sh\necho ran > hook-ran\n").expect("write hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700))
                .expect("make hook executable");
        }
        let sequencer = directory.path().join(".git/sequencer");
        fs::create_dir(&sequencer).expect("create sequencer marker");
        assert_eq!(
            repository_operation(&directory.path().to_string_lossy()),
            Some("cherryPick".into())
        );
        fs::remove_dir(&sequencer).expect("remove sequencer marker");
        fs::write(
            directory.path().join(".git/info/exclude"),
            "generated.txt\n",
        )
        .expect("ignore collision fixture");
        fs::write(directory.path().join("generated.txt"), "local ignored\n")
            .expect("write ignored collision fixture");
        let (repo_root, generation) = root_and_generation(directory.path());
        let metadata = repository_metadata(&repo_root).expect("review metadata");
        assert_eq!(metadata.merge_base_oid.as_deref(), Some(base.as_str()));
        fs::write(directory.path().join(".git/index.lock"), "locked\n")
            .expect("create reviewed index lock");
        let locked = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root.clone(),
            generation.clone(),
            "integrateFastForward".into(),
            local_branch.clone(),
            base.clone(),
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.clone().expect("merge base"),
            "fastForwardOnly".into(),
        )
        .expect("locked reply");
        assert!(!locked.ok);
        assert!(!locked.applied);
        assert_eq!(locked.reason.as_deref(), Some("indexLocked"));
        fs::remove_file(directory.path().join(".git/index.lock"))
            .expect("remove reviewed index lock");
        let collision = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root.clone(),
            generation.clone(),
            "integrateFastForward".into(),
            local_branch.clone(),
            base.clone(),
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.clone().expect("merge base"),
            "fastForwardOnly".into(),
        )
        .expect("collision reply");
        assert!(!collision.ok);
        assert!(!collision.applied);
        assert_eq!(collision.reason.as_deref(), Some("dirtyWorktree"));
        fs::remove_file(directory.path().join("generated.txt"))
            .expect("remove ignored collision fixture");
        let invalid_strategy = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root.clone(),
            generation.clone(),
            "integrateFastForward".into(),
            local_branch.clone(),
            base.clone(),
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.clone().expect("merge base"),
            "merge".into(),
        )
        .expect("invalid strategy reply");
        assert!(!invalid_strategy.ok);
        assert_eq!(invalid_strategy.reason.as_deref(), Some("invalidRequest"));
        let hook_target = repo_root.clone();
        set_mutation_test_hook(Some(Box::new(move |checkpoint, root| {
            if checkpoint == "before-phase4-integrate" && root == hook_target {
                fs::write(Path::new(root).join(".git/index.lock"), "raced\n")
                    .expect("create raced index lock");
            }
        })));
        let uncertain = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root.clone(),
            generation.clone(),
            "integrateFastForward".into(),
            local_branch.clone(),
            base.clone(),
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.clone().expect("merge base"),
            "fastForwardOnly".into(),
        )
        .expect("raced merge reply");
        set_mutation_test_hook(None);
        fs::remove_file(directory.path().join(".git/index.lock")).expect("remove raced index lock");
        assert!(!uncertain.ok);
        assert!(uncertain.applied);
        assert_eq!(uncertain.reason.as_deref(), Some("refreshFailed"));
        let reply = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "integrateFastForward".into(),
            local_branch.clone(),
            base,
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.expect("merge base"),
            "fastForwardOnly".into(),
        )
        .expect("phase4 reply");
        assert!(reply.ok, "{:?}", reply.detail);
        assert!(reply.applied);
        assert_eq!(
            git_stdout(directory.path(), &["rev-parse", "HEAD"]).trim(),
            upstream
        );
        assert_eq!(
            git_stdout(directory.path(), &["branch", "--show-current"]).trim(),
            local_branch
        );
        assert!(
            !directory.path().join("hook-ran").exists(),
            "post-merge hook must not run"
        );
        let (repo_root, generation) = root_and_generation(directory.path());
        let metadata = repository_metadata(&repo_root).expect("post-integration metadata");
        let nothing = repository_phase4_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "integrateFastForward".into(),
            local_branch,
            upstream.clone(),
            upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata
                .merge_base_oid
                .expect("post-integration merge base"),
            "fastForwardOnly".into(),
        )
        .expect("nothing to integrate reply");
        assert!(!nothing.ok);
        assert_eq!(nothing.reason.as_deref(), Some("nothingToIntegrate"));
        assert!(!nothing.applied);
    }

    #[test]
    fn phase4b_rejects_effective_included_and_worktree_git_drivers() {
        let included = init_diverged_repo(true);
        fs::write(
            included.directory.path().join(".gitattributes"),
            "shared.txt merge=reviewed\n",
        )
        .expect("write merge attributes");
        git(included.directory.path(), &["add", ".gitattributes"]);
        git(
            included.directory.path(),
            &["commit", "-q", "-m", "configure reviewed merge driver"],
        );
        let local_head = git_stdout(included.directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        let included_config = included.directory.path().join(".git/phase4b-unsafe.config");
        fs::write(
            &included_config,
            "[merge \"reviewed\"]\n\tdriver = echo ran > driver-ran\n",
        )
        .expect("write included config");
        git(
            included.directory.path(),
            &[
                "config",
                "--local",
                "include.path",
                included_config.to_string_lossy().as_ref(),
            ],
        );
        let (repo_root, generation) = root_and_generation(included.directory.path());
        let merge_base = git_stdout(
            included.directory.path(),
            &["merge-base", &local_head, &included.upstream],
        )
        .trim()
        .to_owned();
        let rejected = repository_phase4b_blocking(
            included.directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "integrateMerge".into(),
            included.local_branch.clone(),
            local_head.clone(),
            included.upstream.clone(),
            "origin".into(),
            "main".into(),
            merge_base,
            "mergeCommit".into(),
            Some("Merge reviewed upstream".into()),
        )
        .expect("reject included merge driver");
        assert!(!rejected.ok);
        assert!(!rejected.applied);
        assert_eq!(
            rejected.reason.as_deref(),
            Some("unsafeRepositoryConfiguration")
        );
        assert_eq!(
            git_stdout(included.directory.path(), &["rev-parse", "HEAD"]).trim(),
            local_head
        );
        assert!(
            !included.directory.path().join("driver-ran").exists(),
            "included merge driver must be rejected before it can run",
        );

        let worktree = init_repo();
        git(
            worktree.path(),
            &["config", "extensions.worktreeConfig", "true"],
        );
        git(
            worktree.path(),
            &[
                "config",
                "--worktree",
                "filter.reviewed.process",
                "should-not-run",
            ],
        );
        assert_eq!(
            ensure_safe_phase4b_config(worktree.path().to_string_lossy().as_ref()).unwrap_err(),
            "unsafeRepositoryConfiguration: executable Git clean filters are not supported"
        );
    }

    #[test]
    fn local_repository_writes_require_the_canonical_target() {
        assert!(require_local_repository_target("local").is_ok());
        let failure = require_local_repository_target("ssh:forged").unwrap_err();
        assert_eq!(failure.reason.as_deref(), Some("invalidRequest"));
        assert!(!failure.applied);
    }

    #[test]
    fn phase4b_creates_only_the_reviewed_merge_commit() {
        let fixture = init_diverged_repo(false);
        let preserved = git_stdout(fixture.directory.path(), &["rev-parse", "preserved"])
            .trim()
            .to_owned();
        let hook = fixture.directory.path().join(".git/hooks/post-merge");
        fs::write(&hook, "#!/bin/sh\necho ran > hook-ran\n").expect("write merge hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700))
                .expect("make merge hook executable");
        }
        let (repo_root, generation) = root_and_generation(fixture.directory.path());
        let metadata = repository_metadata(&repo_root).expect("review metadata");
        let merge_base = metadata.merge_base_oid.expect("merge base");
        let untrimmed = repository_phase4b_blocking(
            fixture.directory.path().to_string_lossy().into_owned(),
            repo_root.clone(),
            generation.clone(),
            "integrateMerge".into(),
            fixture.local_branch.clone(),
            fixture.local_head.clone(),
            fixture.upstream.clone(),
            "origin".into(),
            "main".into(),
            merge_base.clone(),
            "mergeCommit".into(),
            Some(" Merge reviewed upstream ".into()),
        )
        .expect("untrimmed message reply");
        assert!(!untrimmed.ok);
        assert_eq!(untrimmed.reason.as_deref(), Some("invalidRequest"));
        assert!(!untrimmed.applied);
        let reply = repository_phase4b_blocking(
            fixture.directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "integrateMerge".into(),
            fixture.local_branch.clone(),
            fixture.local_head.clone(),
            fixture.upstream.clone(),
            "origin".into(),
            "main".into(),
            merge_base,
            "mergeCommit".into(),
            Some("Merge reviewed upstream".into()),
        )
        .expect("merge reply");
        assert!(reply.ok, "{:?}", reply.detail);
        assert!(reply.applied);
        let final_head = git_stdout(fixture.directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        let parents = git_stdout(
            fixture.directory.path(),
            &["rev-list", "--parents", "-n", "1", &final_head],
        );
        assert_eq!(
            parents.split_whitespace().collect::<Vec<_>>(),
            vec![
                final_head.as_str(),
                fixture.local_head.as_str(),
                fixture.upstream.as_str()
            ]
        );
        assert_eq!(
            git_stdout(fixture.directory.path(), &["log", "-1", "--format=%B"]).trim(),
            "Merge reviewed upstream"
        );
        assert_eq!(
            git_stdout(fixture.directory.path(), &["rev-parse", "preserved"]).trim(),
            preserved
        );
        assert!(!fixture.directory.path().join("hook-ran").exists());
    }

    #[test]
    fn phase4b_rebases_only_a_reviewed_linear_range() {
        let fixture = init_diverged_repo(false);
        let preserved = git_stdout(fixture.directory.path(), &["rev-parse", "preserved"])
            .trim()
            .to_owned();
        let hook = fixture.directory.path().join(".git/hooks/post-rewrite");
        fs::write(&hook, "#!/bin/sh\necho ran > hook-ran\n").expect("write rebase hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&hook, fs::Permissions::from_mode(0o700))
                .expect("make rebase hook executable");
        }
        let (repo_root, generation) = root_and_generation(fixture.directory.path());
        let metadata = repository_metadata(&repo_root).expect("review metadata");
        let reply = repository_phase4b_blocking(
            fixture.directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "integrateRebase".into(),
            fixture.local_branch.clone(),
            fixture.local_head.clone(),
            fixture.upstream.clone(),
            "origin".into(),
            "main".into(),
            metadata.merge_base_oid.expect("merge base"),
            "rebaseLinear".into(),
            None,
        )
        .expect("rebase reply");
        assert!(reply.ok, "{:?}", reply.detail);
        assert!(reply.applied);
        let final_head = git_stdout(fixture.directory.path(), &["rev-parse", "HEAD"])
            .trim()
            .to_owned();
        assert_ne!(final_head, fixture.local_head);
        assert_eq!(
            git_stdout(
                fixture.directory.path(),
                &["merge-base", &final_head, &fixture.upstream],
            )
            .trim(),
            fixture.upstream
        );
        assert_eq!(
            git_stdout(
                fixture.directory.path(),
                &[
                    "rev-list",
                    "--count",
                    &format!("{}..{}", fixture.upstream, final_head),
                ],
            )
            .trim(),
            "1"
        );
        assert_eq!(
            git_stdout(fixture.directory.path(), &["rev-parse", "preserved"]).trim(),
            preserved
        );
        assert!(!fixture.directory.path().join("hook-ran").exists());
    }

    #[test]
    fn phase4b_aborts_conflicts_and_verifies_exact_restoration() {
        for (operation, strategy, message) in [
            (
                "integrateMerge",
                "mergeCommit",
                Some("Merge reviewed upstream".to_owned()),
            ),
            ("integrateRebase", "rebaseLinear", None),
        ] {
            let fixture = init_diverged_repo(true);
            let preserved = git_stdout(fixture.directory.path(), &["rev-parse", "preserved"])
                .trim()
                .to_owned();
            let (repo_root, generation) = root_and_generation(fixture.directory.path());
            let metadata = repository_metadata(&repo_root).expect("review metadata");
            let reply = repository_phase4b_blocking(
                fixture.directory.path().to_string_lossy().into_owned(),
                repo_root.clone(),
                generation,
                operation.into(),
                fixture.local_branch.clone(),
                fixture.local_head.clone(),
                fixture.upstream.clone(),
                "origin".into(),
                "main".into(),
                metadata.merge_base_oid.expect("merge base"),
                strategy.into(),
                message,
            )
            .expect("conflict reply");
            assert!(!reply.ok);
            assert!(!reply.applied);
            assert_eq!(reply.reason.as_deref(), Some("integrationConflict"));
            assert_eq!(
                git_stdout(fixture.directory.path(), &["branch", "--show-current"]).trim(),
                fixture.local_branch
            );
            assert_eq!(
                git_stdout(fixture.directory.path(), &["rev-parse", "HEAD"]).trim(),
                fixture.local_head
            );
            assert_eq!(
                git_stdout(fixture.directory.path(), &["rev-parse", "preserved"]).trim(),
                preserved
            );
            assert!(repository_operation(&repo_root).is_none());
            let status = String::from_utf8(status_porcelain(&repo_root).expect("restored status"))
                .expect("utf8 status");
            assert!(!status.split('\0').any(|record| {
                record.starts_with("1 ")
                    || record.starts_with("2 ")
                    || record.starts_with("u ")
                    || record.starts_with("? ")
            }));
            assert!(!fixture.directory.path().join(".git/index.lock").exists());
        }
    }

    #[test]
    fn phase3_pushes_only_the_reviewed_head_and_rejects_unsafe_push_urls() {
        let directory = init_repo();
        fs::write(directory.path().join("file.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        let remote = tempfile::tempdir().expect("create bare remote");
        git(remote.path(), &["init", "--bare", "-q"]);
        let remote_url = remote.path().to_string_lossy().into_owned();
        git(directory.path(), &["remote", "add", "origin", &remote_url]);
        let branch = git_stdout(directory.path(), &["branch", "--show-current"]);
        let branch = branch.trim();
        git(directory.path(), &["push", "-q", "-u", "origin", branch]);

        fs::write(directory.path().join("local.txt"), "reviewed\n").expect("write local");
        git(directory.path(), &["add", "local.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "reviewed"]);
        let reviewed_head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        let upstream = git_stdout(directory.path(), &["rev-parse", "@{upstream}"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let workspace = directory.path().to_string_lossy().into_owned();
        let stale_destination = repository_phase3_blocking(
            workspace.clone(),
            repo_root.clone(),
            generation.clone(),
            "push".into(),
            None,
            Some(reviewed_head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(format!("{branch}-changed")),
            None,
        )
        .expect("stale destination reply");
        assert!(!stale_destination.ok);
        assert_eq!(stale_destination.reason.as_deref(), Some("staleGeneration"));
        git(
            remote.path(),
            &["update-ref", "-d", &format!("refs/heads/{branch}")],
        );
        let deleted_destination = repository_phase3_blocking(
            workspace.clone(),
            repo_root.clone(),
            generation.clone(),
            "push".into(),
            None,
            Some(reviewed_head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(branch.into()),
            None,
        )
        .expect("deleted destination reply");
        assert!(!deleted_destination.ok);
        assert!(!deleted_destination.applied);
        assert_eq!(
            deleted_destination.reason.as_deref(),
            Some("nonFastForward")
        );
        git(
            remote.path(),
            &[
                "update-ref",
                &format!("refs/heads/{branch}"),
                upstream.trim(),
            ],
        );
        let pushed = repository_phase3_blocking(
            workspace.clone(),
            repo_root.clone(),
            generation,
            "push".into(),
            None,
            Some(reviewed_head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(branch.into()),
            None,
        )
        .expect("push reply");
        assert!(pushed.ok, "{:?}", pushed.detail);
        assert_eq!(
            git_stdout(
                remote.path(),
                &["rev-parse", &format!("refs/heads/{branch}")]
            )
            .trim(),
            reviewed_head.trim()
        );

        fs::write(directory.path().join("another.txt"), "another\n").expect("write another");
        git(directory.path(), &["add", "another.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "another"]);
        git(
            directory.path(),
            &["config", "Remote.origin.PushURL", "ext::malicious"],
        );
        let head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        let upstream = git_stdout(directory.path(), &["rev-parse", "@{upstream}"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let rejected = repository_phase3_blocking(
            workspace,
            repo_root,
            generation,
            "push".into(),
            None,
            Some(head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(branch.into()),
            None,
        )
        .expect("unsafe push reply");
        assert!(!rejected.ok);
        assert!(!rejected.applied);
        assert_eq!(
            rejected.reason.as_deref(),
            Some("unsafeRepositoryConfiguration")
        );

        git(
            directory.path(),
            &["config", "--unset-all", "remote.origin.pushurl"],
        );
        for unsafe_https_url in [
            "https://user:secret-token@example.com/org/repo.git",
            "https://@example.com/org/repo.git",
            "https:///org/repo.git",
            "https://example.com/org/repo.git?token=secret-token",
            "https://example.com/org/repo.git#secret-token",
        ] {
            git(
                directory.path(),
                &["config", "remote.origin.pushurl", unsafe_https_url],
            );
            let (repo_root, generation) = root_and_generation(directory.path());
            let unsafe_https = repository_phase3_blocking(
                directory.path().to_string_lossy().into_owned(),
                repo_root,
                generation,
                "push".into(),
                None,
                Some(head.trim().into()),
                Some(upstream.trim().into()),
                Some("origin".into()),
                Some(branch.into()),
                None,
            )
            .expect("unsafe HTTPS push reply");
            assert!(!unsafe_https.ok);
            assert!(!unsafe_https.applied);
            assert_eq!(
                unsafe_https.reason.as_deref(),
                Some("unsafeRepositoryConfiguration")
            );
            assert!(!unsafe_https
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("secret-token"));
        }
        git(
            directory.path(),
            &["config", "--unset-all", "remote.origin.pushurl"],
        );
        for (key, value) in [
            ("core.askPass", "/tmp/repository-askpass"),
            ("HTTP.Proxy", "http://127.0.0.1:1"),
            ("http.extraHeader", "Authorization: Bearer secret-token"),
            ("http.cookieFile", "/tmp/repository-cookie-jar"),
            ("http.sslKey", "/tmp/repository-client-key"),
        ] {
            git(directory.path(), &["config", key, value]);
            let (repo_root, generation) = root_and_generation(directory.path());
            let credential_source = repository_phase3_blocking(
                directory.path().to_string_lossy().into_owned(),
                repo_root,
                generation,
                "push".into(),
                None,
                Some(head.trim().into()),
                Some(upstream.trim().into()),
                Some("origin".into()),
                Some(branch.into()),
                None,
            )
            .expect("repository-local HTTP configuration reply");
            assert!(!credential_source.ok);
            assert!(!credential_source.applied);
            assert_eq!(
                credential_source.reason.as_deref(),
                Some("unsafeRepositoryConfiguration")
            );
            assert!(!credential_source
                .detail
                .as_deref()
                .unwrap_or_default()
                .contains("secret-token"));
            git(directory.path(), &["config", "--unset-all", key]);
        }
        git(
            directory.path(),
            &["config", "extensions.worktreeConfig", "true"],
        );
        git(
            directory.path(),
            &[
                "config",
                "--worktree",
                "http.extraHeader",
                "Authorization: Bearer worktree-secret",
            ],
        );
        let (worktree_root, worktree_generation) = root_and_generation(directory.path());
        let worktree_http = repository_phase3_blocking(
            directory.path().to_string_lossy().into_owned(),
            worktree_root,
            worktree_generation,
            "push".into(),
            None,
            Some(head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(branch.into()),
            None,
        )
        .expect("worktree-scoped HTTP configuration reply");
        assert!(!worktree_http.ok);
        assert!(!worktree_http.applied);
        assert_eq!(
            worktree_http.reason.as_deref(),
            Some("unsafeRepositoryConfiguration")
        );
        assert!(!worktree_http
            .detail
            .as_deref()
            .unwrap_or_default()
            .contains("worktree-secret"));
        git(
            directory.path(),
            &["config", "--worktree", "--unset-all", "http.extraHeader"],
        );
        let (repo_root, generation) = root_and_generation(directory.path());
        git(
            directory.path(),
            &[
                "config",
                &format!("branch.{branch}.merge"),
                "refs/heads/main:refs/heads/other",
            ],
        );
        let malformed_upstream = repository_metadata(&directory.path().to_string_lossy())
            .expect_err("malformed upstream must be rejected");
        assert!(malformed_upstream.starts_with("unsafeRepositoryConfiguration:"));
        let malformed_push = repository_phase3_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "push".into(),
            None,
            Some(head.trim().into()),
            None,
            Some("origin".into()),
            Some("main:refs/heads/other".into()),
            None,
        )
        .expect("malformed upstream push reply");
        assert!(!malformed_push.ok);
        assert_eq!(
            malformed_push.reason.as_deref(),
            Some("unsafeRepositoryConfiguration")
        );
        git(
            directory.path(),
            &[
                "config",
                &format!("branch.{branch}.merge"),
                &format!("refs/heads/{branch}"),
            ],
        );
        let second_remote = tempfile::tempdir().expect("create second bare remote");
        git(second_remote.path(), &["init", "--bare", "-q"]);
        let second_url = second_remote.path().to_string_lossy().into_owned();
        git(
            directory.path(),
            &["config", "--add", "remote.origin.pushurl", &remote_url],
        );
        git(
            directory.path(),
            &["config", "--add", "remote.origin.pushurl", &second_url],
        );
        let (repo_root, generation) = root_and_generation(directory.path());
        let multiple = repository_phase3_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "push".into(),
            None,
            Some(head.trim().into()),
            Some(upstream.trim().into()),
            Some("origin".into()),
            Some(branch.into()),
            None,
        )
        .expect("multiple push destinations reply");
        assert!(!multiple.ok);
        assert_eq!(
            multiple.reason.as_deref(),
            Some("unsafeRepositoryConfiguration")
        );
        let unexpected = Command::new("git")
            .arg("-C")
            .arg(second_remote.path())
            .args(["rev-parse", &format!("refs/heads/{branch}")])
            .output()
            .expect("inspect second remote");
        assert!(!unexpected.status.success());
    }

    #[test]
    fn phase3_switch_refuses_to_overwrite_or_stash_local_changes() {
        let directory = init_repo();
        fs::write(directory.path().join("file.txt"), "base\n").expect("write base");
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "base"]);
        let (repo_root, generation) = root_and_generation(directory.path());
        let stale_create = repository_phase3_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "createBranch".into(),
            None,
            Some("0".repeat(40)),
            None,
            None,
            None,
            Some("stale-branch".into()),
        )
        .expect("stale branch source reply");
        assert!(!stale_create.ok);
        assert_eq!(stale_create.reason.as_deref(), Some("staleGeneration"));
        assert!(git_stdout(directory.path(), &["branch", "--list", "stale-branch"]).is_empty());
        let original = git_stdout(directory.path(), &["branch", "--show-current"]);
        let original = original.trim();
        git(directory.path(), &["switch", "-q", "-c", "conflicting"]);
        fs::write(directory.path().join("file.txt"), "branch version\n")
            .expect("write branch version");
        git(directory.path(), &["add", "file.txt"]);
        git(directory.path(), &["commit", "-q", "-m", "branch version"]);
        git(directory.path(), &["switch", "-q", original]);
        fs::write(directory.path().join("file.txt"), "local version\n")
            .expect("write local version");
        let (repo_root, generation) = root_and_generation(directory.path());
        let reply = repository_phase3_blocking(
            directory.path().to_string_lossy().into_owned(),
            repo_root,
            generation,
            "switchBranch".into(),
            None,
            None,
            None,
            None,
            None,
            Some("conflicting".into()),
        )
        .expect("switch reply");
        assert!(!reply.ok);
        assert_eq!(reply.reason.as_deref(), Some("checkoutConflict"));
        assert_eq!(
            git_stdout(directory.path(), &["branch", "--show-current"]).trim(),
            original
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("file.txt")).expect("read local version"),
            "local version\n"
        );
        assert!(git_stdout(directory.path(), &["stash", "list"]).is_empty());
    }
}
