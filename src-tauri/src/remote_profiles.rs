//! Non-secret SSH target profiles and the fixed remote launcher contract.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use pi_backend_core::pi_process::LaunchSpec;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Save-time fallback, kept for profiles written before the in-app installer
/// existed. New profiles get the resolved path returned by the installer, which
/// defaults to a `$HOME` location that needs no sudo.
const DEFAULT_LAUNCHER_PATH: &str = "/usr/local/bin/pi-desktop-launcher";
/// Asks the remote installer to resolve `$HOME/.local/bin/pi-desktop-launcher`.
/// `$HOME` cannot be expanded locally, and the stored path must be absolute, so
/// the installer echoes the path it resolved and that is what gets saved.
const LAUNCHER_PATH_SENTINEL: &str = "-";
const LAUNCHER_PROTOCOL_VERSION: u32 = 1;
/// Embedded so the installed launcher cannot drift from this build.
const LAUNCHER_SOURCE: &str = include_str!("../../remote-launcher/pi-desktop-launcher");
const SSH_CONNECT_TIMEOUT_OPTION: &str = "ConnectTimeout=15";
/// `ConnectTimeout` only covers dialing. Without a liveness probe on the
/// established channel, a network partition leaves the local `ssh` blocked on a
/// socket that will never answer: no exit, no error, no `pi://exit` event — the
/// UI stays "running" and Stop writes into a dead pipe. These two options make
/// OpenSSH tear the channel down after roughly
/// `ServerAliveInterval * ServerAliveCountMax` seconds of silence, which is what
/// turns an invisible hang into an exit the desktop can react to.
///
/// The probe is an SSH-protocol keepalive, so an idle-but-reachable host answers
/// it: only a genuinely unreachable peer or a dead sshd advances the counter.
const SSH_SERVER_ALIVE_INTERVAL_OPTION: &str = "ServerAliveInterval=15";
const SSH_SERVER_ALIVE_COUNT_OPTION: &str = "ServerAliveCountMax=3";
const PREFLIGHT_OUTPUT_MAX_BYTES: usize = 64 * 1024;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PROFILE_NAME_BYTES: usize = 256;
const MAX_HOST_ALIAS_BYTES: usize = 256;
const MAX_REMOTE_PATH_BYTES: usize = 4096;
const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
/// pi's channel and its lifetime are the same thing: it dies with the SSH session.
const LIFECYCLE_ATTACHED: &str = "attached";
/// pi outlives the channel, supervised by the launcher's detached-task modes.
/// See docs/remote-agent-v2-supervisor-protocol.md.
const LIFECYCLE_DETACHED: &str = "detached";
/// Minted by the desktop, never by the launcher, and matched verbatim there.
const MAX_REMOTE_TASK_ID_BYTES: usize = 64;
const MIN_REMOTE_TASK_ID_BYTES: usize = 8;
static PROFILE_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePiProfile {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub ssh_host: String,
    /// Where a folder browser opens on this host, **not** where pi runs.
    ///
    /// The workspace moved to `ExecutionBinding` because it is a per-conversation
    /// choice, not host configuration — a profile describes a machine, and one machine
    /// holds many projects. This stays only so browsing has a useful starting point;
    /// `None` falls back to the remote `$HOME` from preflight. Profiles written before
    /// the split keep their value and it keeps meaning the same thing.
    #[serde(default)]
    pub remote_cwd: Option<String>,
    pub pi_executable: Option<String>,
    pub launcher_path: String,
    pub launcher_protocol_version: u32,
    pub lifecycle: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePiProfileInput {
    pub id: Option<String>,
    pub name: String,
    pub ssh_host: String,
    /// Optional browse starting point — see `RemotePiProfile::remote_cwd`.
    #[serde(default)]
    pub remote_cwd: Option<String>,
    pub pi_executable: Option<String>,
    pub launcher_path: Option<String>,
    pub launcher_protocol_version: Option<u32>,
    /// Omitted keeps an existing profile's lifecycle and defaults a new one to
    /// `attached`, so a caller that predates detached tasks cannot flip one.
    pub lifecycle: Option<String>,
}

/// `rename_all` renames the **variants** (`Local` → `local`); it does *not* touch the
/// fields inside them. Without `rename_all_fields` this type expected `profile_id` while
/// every caller sends `profileId`, so deserializing a remote binding failed with
/// `missing field profile_id` and serializing wrote snake_case that the frontend then
/// read back as `undefined`. Both directions were wrong, and no test caught it because
/// every Rust test constructs the variant in Rust rather than parsing what the app sends.
/// The wire shape is pinned by `the_wire_shape_is_what_the_frontend_actually_sends`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ExecutionBinding {
    Local {
        target_id: String,
    },
    Ssh {
        profile_id: String,
        profile_revision: u64,
        host_alias: String,
        remote_cwd: String,
        launcher_protocol_version: u32,
        /// Which remote task this binding drives. Present exactly when the profile
        /// is `detached`.
        ///
        /// Deliberately orthogonal to `generation`: generation is a local
        /// per-spawn counter in `pi_bridge.rs`, and attaching to a task opens a new
        /// local ssh child — a new generation against the *same* remote task.
        /// Conflating the two makes replayed events get filtered out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        remote_task_id: Option<String>,
    },
}

/// One row of the setup checklist. `id` is a stable key the UI maps to a label
/// and a fix action; `detail` is already-human text (a version string, a path).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReadinessCheck {
    pub id: &'static str,
    /// `ok` | `failed` | `warning` | `skipped`
    pub status: &'static str,
    pub detail: Option<String>,
    pub error_code: Option<&'static str>,
    pub error: Option<String>,
}

impl RemoteReadinessCheck {
    fn ok(id: &'static str, detail: Option<String>) -> Self {
        Self { id, status: "ok", detail, error_code: None, error: None }
    }

    fn failed(id: &'static str, error_code: &'static str, error: String) -> Self {
        Self { id, status: "failed", detail: None, error_code: Some(error_code), error: Some(error) }
    }

    fn warning(id: &'static str, error_code: &'static str, error: String) -> Self {
        Self { id, status: "warning", detail: None, error_code: Some(error_code), error: Some(error) }
    }

    /// Not reached — an earlier check failed and this one could not be observed.
    fn skipped(id: &'static str) -> Self {
        Self { id, status: "skipped", detail: None, error_code: None, error: None }
    }
}

/// Ordered, per-prerequisite result of one preflight round trip. Replaces the
/// single opaque error string: every distinct failure mode the launcher and SSH
/// can report lands on its own row so the UI can point at the field to fix.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReadinessReport {
    pub ok: bool,
    pub profile_id: Option<String>,
    pub host: String,
    pub remote_cwd: String,
    pub launcher_path: String,
    pub pi_version: Option<String>,
    /// The remote `$HOME`, so a folder browser has somewhere to open. The desktop
    /// cannot expand it locally and the launcher only accepts absolute paths, so
    /// without this the first browse would start at `/`.
    pub home: Option<String>,
    pub checks: Vec<RemoteReadinessCheck>,
}

pub const CHECK_SSH: &str = "ssh";
pub const CHECK_LAUNCHER: &str = "launcher";
pub const CHECK_NODE: &str = "node";
pub const CHECK_WORKSPACE: &str = "workspace";
pub const CHECK_PI: &str = "pi";
pub const CHECK_PI_AUTH: &str = "piAuth";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherInstallResult {
    pub launcher_path: String,
    pub host: String,
}

/// What one launcher reports it can do.
///
/// Exists because an unknown mode is indistinguishable from a broken launcher:
/// the V1 launcher answers any unrecognised mode with `invalid launcher mode` and
/// exit 64, so a newer desktop could not tell "this host needs a launcher
/// upgrade" from "this launcher is corrupt". Measured for real on an Ubuntu host
/// whose installed launcher predated provider-sync — see
/// `docs/remote-agent-v1-acceptance.md`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherCapabilities {
    pub host: String,
    pub launcher_path: String,
    /// Payload-protocol version for run/preflight. Capabilities are versioned
    /// independently, so this must not be used to infer any capability.
    pub launcher_protocol_version: u32,
    /// The host's launcher build. `0` means it does not report one, i.e. older
    /// than every build that does. The only field that can order two launchers.
    pub launcher_revision: u32,
    /// The host's task-state version, or `0` when unreported. Compare against
    /// this build's before replacing the file: a mismatch strands live tasks.
    pub status_version: u32,
    pub capabilities: Vec<String>,
    /// `true` when the launcher answered `--capabilities` at all. A launcher
    /// predating this mode reports `false` with an empty list and no error: it is
    /// a supported, degradable state, not a failure.
    pub supports_capability_query: bool,
    /// Set when the query failed for a reason the user must act on (unreachable
    /// host, missing launcher). Distinct from an old launcher.
    pub error_code: Option<String>,
    pub error: Option<String>,
}

/// Reply parsed from `--capabilities`. Bounded and non-exhaustive on purpose:
/// unknown fields from a newer launcher are ignored rather than rejected.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilitiesReply {
    launcher_protocol_version: u32,
    /// This build's identity. Absent on any launcher predating it, and `0` is
    /// deliberately "older than anything we ship" rather than an error.
    #[serde(default)]
    launcher_revision: u32,
    /// The on-disk task-state version. `0` means the launcher does not report it,
    /// which must be read as "unknown", never as "compatible".
    #[serde(default)]
    status_version: u32,
    capabilities: Vec<String>,
}

/// This build's embedded launcher revision. Must equal `launcherRevision` in
/// `remote-launcher/pi-desktop-launcher`; a test pins the two together.
const LAUNCHER_REVISION: u32 = 1;
/// The task-state version this build's launcher reads and writes.
const LAUNCHER_STATUS_VERSION: u32 = 1;

/// A launcher too old to answer `--capabilities`.
const EXIT_INVALID_LAUNCHER_MODE: i32 = 64;
/// `sh` reports a missing command this way; the launcher itself is absent.
const EXIT_COMMAND_NOT_FOUND: i32 = 127;
const CAPABILITIES_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CAPABILITY_ENTRIES: usize = 64;
const MAX_CAPABILITY_NAME_BYTES: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPayload<'a> {
    protocol_version: u32,
    /// Absent only for a preflight with no workspace chosen yet — the launcher then
    /// runs `pi --version` from `$HOME` and reports no workspace row.
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<&'a str>,
    pi_executable: &'a str,
    resume_path: Option<&'a str>,
    /// Only present for `--start-detached`; the run payload has no task.
    #[serde(skip_serializing_if = "Option::is_none")]
    remote_task_id: Option<&'a str>,
}

/// `--attach`'s payload is its own shape: it addresses a task rather than describing
/// how to launch one, so it carries no cwd, executable, or resume path.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachPayload<'a> {
    protocol_version: u32,
    remote_task_id: &'a str,
    after: Option<u64>,
    follow: bool,
}

/// One workspace request. `encoding` applies to `read` and `write`; `to` to `rename`;
/// `expected_hash` to `write` and `delete`.
///
/// `expected_hash` is `Option<Option<String>>` because the three states are distinct
/// and the launcher acts differently on each: absent means the caller has not decided
/// (refused), explicit `null` asserts the path is free, and a token is If-Match.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePayload<'a> {
    protocol_version: u32,
    operation: &'a str,
    path: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    encoding: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_hash: Option<Option<&'a str>>,
}

/// Whatever the launcher answered, passed through untyped.
///
/// Deliberately not a per-operation enum: the reply already carries `ok` and
/// `operation`, the frontend port is the thing that discriminates them, and adding a
/// second Rust-side schema would mean two places to update for every new field.
/// Bounded by `WORKSPACE_OUTPUT_MAX_BYTES` on the way in.
pub type RemoteWorkspaceReply = serde_json::Value;

/// Read-only browsing replies can be large — a 2 MiB file, or a 2000-entry listing —
/// so they get their own ceiling rather than the 64 KiB one preflight uses. The
/// launcher refuses to send more than 8 MiB; this leaves room for that plus framing.
const WORKSPACE_OUTPUT_MAX_BYTES: usize = 9 * 1024 * 1024;
const WORKSPACE_TIMEOUT: Duration = Duration::from_secs(30);
/// Longer than the rest: `--stop` waits up to 5s for the supervisor to confirm the
/// process actually died before escalating to SIGKILL, and that wait is on the far side.
const STOP_TIMEOUT: Duration = Duration::from_secs(45);
const WORKSPACE_OPERATIONS: [&str; 8] =
    ["list", "read", "stat", "write", "create", "mkdir", "delete", "rename"];
/// The operations that mutate. Only these accept a body, and only `write` has one.
const WORKSPACE_WRITE_OPERATIONS: [&str; 5] = ["write", "create", "mkdir", "delete", "rename"];
const WORKSPACE_ENCODINGS: [&str; 2] = ["utf8", "base64"];
/// Matches the launcher: a token it minted, not a checksum the caller computed.
const WORKSPACE_HASH_PREFIX: &str = "sha256-";
const WORKSPACE_HASH_HEX_LEN: usize = 64;
/// The launcher caps a file at 2 MiB; base64 inflates that by 4/3 on the way up.
const WORKSPACE_BODY_MAX_BYTES: usize = 3 * 1024 * 1024;

fn profile_path() -> Result<PathBuf, String> {
    Ok(crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("remote-profiles.json"))
}

fn lock_profile_store() -> Result<MutexGuard<'static, ()>, String> {
    PROFILE_STORE_LOCK
        .lock()
        .map_err(|_| "remote profile store lock is poisoned".to_owned())
}

fn load_profiles() -> Result<Vec<RemotePiProfile>, String> {
    let path = profile_path()?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content =
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let profiles: Vec<RemotePiProfile> =
        serde_json::from_str(&content).map_err(|e| format!("invalid remote profiles: {e}"))?;
    let mut ids = HashSet::with_capacity(profiles.len());
    for profile in &profiles {
        validate_profile(profile)?;
        if !ids.insert(profile.id.as_str()) {
            return Err(format!("duplicate remote profile id `{}`", profile.id));
        }
    }
    Ok(profiles)
}

fn save_profiles(profiles: &[RemotePiProfile]) -> Result<(), String> {
    let path = profile_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, format!("{content}\n")).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        if path.is_file() {
            let backup = path.with_extension("json.bak");
            if backup.exists() {
                fs::remove_file(&backup).map_err(|e| e.to_string())?;
            }
            fs::rename(&path, &backup).map_err(|e| e.to_string())?;
            if let Err(error) = fs::rename(&temporary, &path) {
                let _ = fs::rename(&backup, &path);
                return Err(error.to_string());
            }
            let _ = fs::remove_file(backup);
            return Ok(());
        }
    }
    fs::rename(&temporary, &path).map_err(|e| e.to_string())
}

fn validate_profile_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > MAX_PROFILE_ID_BYTES
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("remote profile id is invalid".into());
    }
    Ok(())
}

fn validate_host_alias(host: &str) -> Result<(), String> {
    if host.trim() != host
        || host.is_empty()
        || host.len() > MAX_HOST_ALIAS_BYTES
        || host.starts_with('-')
        || !host.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '@' | '+' | ':')
        })
    {
        return Err("SSH host alias is invalid".into());
    }
    Ok(())
}

fn validate_remote_path(path: &str, label: &str) -> Result<(), String> {
    if path.trim() != path
        || !path.starts_with('/')
        || path.len() > MAX_REMOTE_PATH_BYTES
        || path.chars().any(char::is_control)
    {
        return Err(format!("{label} must be an absolute POSIX path"));
    }
    Ok(())
}

fn launcher_or_default(launcher: Option<&str>) -> &str {
    match launcher {
        Some(value) if !value.trim().is_empty() => value,
        _ => DEFAULT_LAUNCHER_PATH,
    }
}

fn trimmed_option(value: Option<&str>) -> Option<&str> {
    value.filter(|item| !item.trim().is_empty())
}

fn validate_profile_fields(
    name: &str,
    host: &str,
    cwd: Option<&str>,
    pi_executable: Option<&str>,
    launcher: &str,
    protocol_version: u32,
) -> Result<(), String> {
    if name.trim().is_empty()
        || name.len() > MAX_PROFILE_NAME_BYTES
        || name.chars().any(char::is_control)
    {
        return Err("remote profile name must be between 1 and 256 bytes".into());
    }
    validate_host_alias(host)?;
    // A browse starting point is optional; only a present one has to be well formed.
    if let Some(cwd) = cwd {
        validate_remote_path(cwd, "remote browse directory")?;
    }
    validate_remote_path(launcher, "remote launcher")?;
    if let Some(executable) = pi_executable {
        if executable.trim().is_empty()
            || executable.trim() != executable
            || executable.len() > MAX_REMOTE_PATH_BYTES
            || executable.chars().any(char::is_control)
        {
            return Err("remote Pi executable is invalid".into());
        }
    }
    if protocol_version != LAUNCHER_PROTOCOL_VERSION {
        return Err(format!(
            "unsupported remote launcher protocol version {protocol_version}"
        ));
    }
    Ok(())
}

fn validate_lifecycle(lifecycle: &str) -> Result<(), String> {
    if lifecycle != LIFECYCLE_ATTACHED && lifecycle != LIFECYCLE_DETACHED {
        return Err(format!("unsupported remote lifecycle `{lifecycle}`"));
    }
    Ok(())
}

/// Mirrors the launcher's `^[a-z0-9][a-z0-9-]{7,63}$` exactly. Both ends validate
/// it: the desktop so a malformed id never reaches a host, the launcher so it never
/// trusts one it was handed.
fn validate_remote_task_id(task_id: &str) -> Result<(), String> {
    let first_is_alphanumeric = task_id
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit());
    if task_id.len() < MIN_REMOTE_TASK_ID_BYTES
        || task_id.len() > MAX_REMOTE_TASK_ID_BYTES
        || !first_is_alphanumeric
        || !task_id
            .chars()
            .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-')
    {
        return Err("remote task id is invalid".into());
    }
    Ok(())
}

fn validate_profile(profile: &RemotePiProfile) -> Result<(), String> {
    validate_profile_id(&profile.id)?;
    if profile.revision == 0 || profile.revision > MAX_SAFE_JS_INTEGER {
        return Err(format!(
            "remote profile `{}` has invalid metadata",
            profile.id
        ));
    }
    validate_lifecycle(&profile.lifecycle)?;
    validate_profile_fields(
        &profile.name,
        &profile.ssh_host,
        profile.remote_cwd.as_deref(),
        profile.pi_executable.as_deref(),
        &profile.launcher_path,
        profile.launcher_protocol_version,
    )
}

#[tauri::command]
pub fn remote_profiles_list() -> Result<Vec<RemotePiProfile>, String> {
    let _guard = lock_profile_store()?;
    load_profiles()
}

#[tauri::command]
pub fn remote_profile_save(profile: RemotePiProfileInput) -> Result<RemotePiProfile, String> {
    let _guard = lock_profile_store()?;
    let launcher = launcher_or_default(profile.launcher_path.as_deref());
    let protocol_version = profile
        .launcher_protocol_version
        .unwrap_or(LAUNCHER_PROTOCOL_VERSION);
    let pi_executable = trimmed_option(profile.pi_executable.as_deref());
    // A cleared form field means "unset", not "the empty path".
    let browse_directory = trimmed_option(profile.remote_cwd.as_deref());
    validate_profile_fields(
        &profile.name,
        &profile.ssh_host,
        browse_directory,
        pi_executable,
        launcher,
        protocol_version,
    )?;
    if let Some(id) = profile.id.as_deref() {
        validate_profile_id(id)?;
    }

    let mut profiles = load_profiles()?;
    let existing = match profile.id.as_deref() {
        Some(id) => Some(
            profiles
                .iter()
                .find(|item| item.id == id)
                .cloned()
                .ok_or_else(|| format!("remote profile `{id}` was not found"))?,
        ),
        None => None,
    };
    let id = match existing.as_ref() {
        Some(item) => item.id.clone(),
        None => next_profile_id(&profiles)?,
    };
    let revision = match existing.as_ref() {
        Some(item) if item.revision >= MAX_SAFE_JS_INTEGER => {
            return Err("remote profile revision overflow".into());
        }
        Some(item) => item.revision + 1,
        None => 1,
    };
    // An omitted lifecycle keeps whatever the profile already had, so a caller that
    // predates detached tasks round-trips a profile without silently downgrading it.
    let lifecycle = match trimmed_option(profile.lifecycle.as_deref()) {
        Some(value) => {
            validate_lifecycle(value)?;
            value.to_owned()
        }
        None => existing
            .as_ref()
            .map_or_else(|| LIFECYCLE_ATTACHED.to_owned(), |item| item.lifecycle.clone()),
    };
    let saved = RemotePiProfile {
        id,
        revision,
        name: profile.name.trim().to_owned(),
        ssh_host: profile.ssh_host,
        remote_cwd: browse_directory.map(str::to_owned),
        pi_executable: pi_executable.map(str::to_owned),
        launcher_path: launcher.to_owned(),
        launcher_protocol_version: protocol_version,
        lifecycle,
    };
    validate_profile(&saved)?;
    if let Some(index) = profiles.iter().position(|item| item.id == saved.id) {
        profiles[index] = saved.clone();
    } else {
        profiles.push(saved.clone());
    }
    save_profiles(&profiles)?;
    Ok(saved)
}
fn next_profile_id(profiles: &[RemotePiProfile]) -> Result<String, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let base = format!("remote-{now:x}");
    if profiles.iter().all(|profile| profile.id != base) {
        return Ok(base);
    }
    for suffix in 2..=u64::MAX {
        let candidate = format!("{base}-{suffix}");
        if profiles.iter().all(|profile| profile.id != candidate) {
            return Ok(candidate);
        }
    }
    Err("cannot allocate a unique remote profile id".into())
}

#[tauri::command]
pub fn remote_profile_delete(id: String) -> Result<(), String> {
    let _guard = lock_profile_store()?;
    validate_profile_id(&id)?;
    let mut profiles = load_profiles()?;
    let original_len = profiles.len();
    profiles.retain(|profile| profile.id != id);
    if profiles.len() == original_len {
        return Err(format!("remote profile `{id}` was not found"));
    }
    save_profiles(&profiles)
}

pub fn load_profile(id: &str) -> Result<RemotePiProfile, String> {
    validate_profile_id(id)?;
    let _guard = lock_profile_store()?;
    load_profiles()?
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| format!("remote profile `{id}` was not found"))
}

pub fn validate_binding(
    profile: &RemotePiProfile,
    binding: &ExecutionBinding,
) -> Result<(), String> {
    validate_profile(profile)?;
    let ExecutionBinding::Ssh {
        profile_id,
        profile_revision,
        host_alias,
        remote_cwd,
        launcher_protocol_version,
        remote_task_id,
    } = binding
    else {
        return Ok(());
    };
    if profile_id != &profile.id {
        return Err("remote execution binding references a different profile".into());
    }
    if *profile_revision != profile.revision {
        return Err(format!(
            "remote profile `{profile_id}` changed from revision {profile_revision} to {}",
            profile.revision
        ));
    }
    if host_alias != &profile.ssh_host
        || *launcher_protocol_version != profile.launcher_protocol_version
    {
        return Err("remote execution binding does not match the stored profile".into());
    }
    // `remote_cwd` is deliberately NOT compared against the profile.
    //
    // It used to be, back when a profile owned exactly one workspace. The workspace is
    // now a per-conversation choice — one machine holds many projects — so a binding
    // pointing somewhere the profile does not mention is normal, not drift. The
    // revision check above still guards what it was always meant to guard: host
    // configuration. A directory never was host configuration.
    //
    // It still has to be a well-formed absolute path, because it becomes pi's cwd.
    validate_remote_path(remote_cwd, "remote workspace")?;
    // The task id is present exactly when the profile is detached. A detached
    // binding without one has nothing to attach to; an attached binding with one
    // would name a task no attached run can reach.
    match (profile.lifecycle.as_str(), remote_task_id.as_deref()) {
        (LIFECYCLE_DETACHED, Some(task_id)) => validate_remote_task_id(task_id),
        (LIFECYCLE_DETACHED, None) => {
            Err("a detached remote binding must carry a remote task id".into())
        }
        (_, Some(_)) => Err("an attached remote binding cannot carry a remote task id".into()),
        (_, None) => Ok(()),
    }
}

pub fn ssh_launch_spec(
    profile: &RemotePiProfile,
    binding: &ExecutionBinding,
    resume_path: Option<&str>,
) -> Result<LaunchSpec, String> {
    let ExecutionBinding::Ssh {
        remote_cwd,
        launcher_protocol_version,
        ..
    } = binding
    else {
        return Err("SSH launch requested for a local execution binding".into());
    };
    validate_binding(profile, binding)?;
    // Fail closed rather than silently doing the attached thing: `--run` holds the
    // channel open for pi's stdio, which is the one shape a detached task must not
    // have. Attaching to a detached task is V2.2 and gets its own path.
    if profile.lifecycle == LIFECYCLE_DETACHED {
        return Err("a detached remote profile cannot be launched with --run".into());
    }
    let encoded = encode_launcher_payload(
        Some(remote_cwd),
        profile.pi_executable.as_deref().unwrap_or("pi"),
        *launcher_protocol_version,
        resume_path,
        None,
    )?;
    Ok(ssh_spec_for(
        &profile.ssh_host,
        &profile.launcher_path,
        "--run",
        &encoded,
    ))
}

/// `--start-detached`: same payload as `--run` plus the task id. The reply is one
/// JSON line and the channel closes immediately — the task outlives it.
///
/// Not called yet. V2.1 owns the protocol and its argv policy; the desktop call
/// sites arrive with V2.2 attach, which is the first thing that has a task to
/// attach to. Kept here, with tests, so the argv can be locked down before a
/// consumer depends on it.
#[allow(dead_code)]
pub fn ssh_start_detached_spec(
    profile: &RemotePiProfile,
    binding: &ExecutionBinding,
    resume_path: Option<&str>,
) -> Result<LaunchSpec, String> {
    let ExecutionBinding::Ssh {
        remote_cwd,
        launcher_protocol_version,
        remote_task_id,
        ..
    } = binding
    else {
        return Err("detached launch requested for a local execution binding".into());
    };
    validate_binding(profile, binding)?;
    if profile.lifecycle != LIFECYCLE_DETACHED {
        return Err("an attached remote profile cannot be started detached".into());
    }
    let task_id = remote_task_id
        .as_deref()
        .ok_or("a detached remote binding must carry a remote task id")?;
    let encoded = encode_launcher_payload(
        Some(remote_cwd),
        profile.pi_executable.as_deref().unwrap_or("pi"),
        *launcher_protocol_version,
        resume_path,
        Some(task_id),
    )?;
    Ok(ssh_spec_for(
        &profile.ssh_host,
        &profile.launcher_path,
        "--start-detached",
        &encoded,
    ))
}

/// `--status`, `--stop` and `--send` take a bare task id, not a base64 payload: an
/// id is already constrained to `[a-z0-9-]`, so encoding it would only hide a
/// malformed one. `--reap` takes nothing.
///
/// Not called yet — see `ssh_start_detached_spec`.
#[allow(dead_code)]
pub fn ssh_task_spec(
    profile: &RemotePiProfile,
    mode: RemoteTaskMode,
    task_id: Option<&str>,
) -> Result<LaunchSpec, String> {
    validate_profile(profile)?;
    let mut spec = LaunchSpec::new("ssh");
    for &argument in ssh_options() {
        spec = spec.arg(argument);
    }
    spec = spec
        .arg(profile.ssh_host.clone())
        .arg(shell_quote(&profile.launcher_path))
        .arg(mode.as_argument());
    match (mode, task_id) {
        (RemoteTaskMode::Reap, Some(_)) => Err("--reap takes no task id".into()),
        (RemoteTaskMode::Stop | RemoteTaskMode::Send, None) => {
            Err(format!("{} requires a task id", mode.as_argument()))
        }
        (_, Some(task_id)) => {
            validate_remote_task_id(task_id)?;
            Ok(spec.arg(shell_quote(task_id)))
        }
        (_, None) => Ok(spec),
    }
}

/// The launcher modes that address an existing task. `--start-detached` is not one
/// of them: it carries a payload, not an id.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteTaskMode {
    Status,
    Stop,
    Send,
    Reap,
}

impl RemoteTaskMode {
    fn as_argument(self) -> &'static str {
        match self {
            Self::Status => "--status",
            Self::Stop => "--stop",
            Self::Send => "--send",
            Self::Reap => "--reap",
        }
    }
}

/// `--attach`: the long-lived read-only channel over a detached task's journal.
///
/// Shaped like `--run` on purpose — one ssh child whose stdout is a stream of lines —
/// so it drops into the existing `pi://line` plumbing. The difference is that each
/// line is an attach frame wrapping a journal record, and the desktop unwraps it and
/// tracks `sequence` as its cursor. See docs/remote-agent-v2-session-recovery.md.
///
/// `after` is the highest sequence the caller has already applied; `None` starts from
/// the oldest record still retained. Not called yet — see `ssh_start_detached_spec`.
#[allow(dead_code)]
pub fn ssh_attach_spec(
    profile: &RemotePiProfile,
    binding: &ExecutionBinding,
    after: Option<u64>,
    follow: bool,
) -> Result<LaunchSpec, String> {
    let ExecutionBinding::Ssh { remote_task_id, .. } = binding else {
        return Err("attach requested for a local execution binding".into());
    };
    validate_binding(profile, binding)?;
    if profile.lifecycle != LIFECYCLE_DETACHED {
        return Err("only a detached remote profile has a task to attach to".into());
    }
    let task_id = remote_task_id
        .as_deref()
        .ok_or("a detached remote binding must carry a remote task id")?;
    validate_remote_task_id(task_id)?;
    if after.is_some_and(|cursor| cursor > MAX_SAFE_JS_INTEGER) {
        return Err("remote attach cursor is out of range".into());
    }
    let payload = AttachPayload {
        protocol_version: LAUNCHER_PROTOCOL_VERSION,
        remote_task_id: task_id,
        after,
        follow,
    };
    let encoded = STANDARD.encode(
        serde_json::to_vec(&payload).map_err(|e| format!("encode attach payload: {e}"))?,
    );
    Ok(ssh_spec_for(
        &profile.ssh_host,
        &profile.launcher_path,
        "--attach",
        &encoded,
    ))
}

/// `remote_cwd` is `None` only for a preflight with no workspace chosen yet — every
/// run payload has one, because pi has to start somewhere.
fn encode_launcher_payload(
    remote_cwd: Option<&str>,
    pi_executable: &str,
    protocol_version: u32,
    resume_path: Option<&str>,
    remote_task_id: Option<&str>,
) -> Result<String, String> {
    let resume_path = resume_path.filter(|path| !path.is_empty());
    if let Some(path) = resume_path {
        if path.trim() != path
            || !path.starts_with('/')
            || path.len() > MAX_REMOTE_PATH_BYTES
            || path.chars().any(char::is_control)
        {
            return Err("remote session path is invalid".into());
        }
    }
    if let Some(task_id) = remote_task_id {
        validate_remote_task_id(task_id)?;
    }
    let payload = LauncherPayload {
        protocol_version,
        cwd: remote_cwd,
        pi_executable,
        resume_path,
        remote_task_id,
    };
    Ok(STANDARD
        .encode(serde_json::to_vec(&payload).map_err(|e| format!("encode launcher payload: {e}"))?))
}

fn ssh_spec_for(
    host: &str,
    launcher_path: &str,
    mode: &'static str,
    payload_base64: &str,
) -> LaunchSpec {
    let mut spec = LaunchSpec::new("ssh");
    for &argument in ssh_options() {
        spec = spec.arg(argument);
    }
    spec.arg(host.to_owned())
        .arg(shell_quote(launcher_path))
        .arg(shell_quote(mode))
        .arg(shell_quote(payload_base64))
}

pub(crate) fn ssh_provider_sync_spec(profile: &RemotePiProfile) -> LaunchSpec {
    let mut spec = LaunchSpec::new("ssh");
    for &argument in ssh_options() {
        spec = spec.arg(argument);
    }
    spec.arg(profile.ssh_host.clone())
        .arg(shell_quote(&profile.launcher_path))
        .arg("--provider-sync")
}

fn ssh_capabilities_spec(host: &str, launcher_path: &str) -> LaunchSpec {
    let mut spec = LaunchSpec::new("ssh");
    for &argument in ssh_options() {
        spec = spec.arg(argument);
    }
    spec.arg(host.to_owned())
        .arg(shell_quote(launcher_path))
        .arg("--capabilities")
}

/// Asks a host's launcher what it supports.
///
/// Fails soft by design. An old launcher (exit 64) and a launcher that answers
/// with something unparseable both come back as `supports_capability_query:
/// false` with no `error_code`, because the caller's correct response is the same
/// in both cases: fall back to V1 behaviour. Only conditions the user must fix —
/// an unreachable host, a missing launcher — set `error_code`.
pub fn probe_launcher_capabilities(
    host: &str,
    launcher_path: &str,
) -> Result<LauncherCapabilities, String> {
    validate_host_alias(host)?;
    validate_remote_path(launcher_path, "remote launcher")?;
    let spec = ssh_capabilities_spec(host, launcher_path);
    let unsupported = |error_code: Option<&str>, error: Option<String>| LauncherCapabilities {
        host: host.to_owned(),
        launcher_path: launcher_path.to_owned(),
        launcher_protocol_version: 0,
        launcher_revision: 0,
        status_version: 0,
        capabilities: Vec::new(),
        supports_capability_query: false,
        error_code: error_code.map(str::to_owned),
        error,
    };

    let output = match run_bounded_command(&spec, CAPABILITIES_TIMEOUT, None, PREFLIGHT_OUTPUT_MAX_BYTES) {
        Ok(output) => output,
        // A local failure to even launch ssh is worth surfacing verbatim.
        Err(error) => return Ok(unsupported(Some("sshUnavailable"), Some(error))),
    };
    if output.timed_out {
        return Ok(unsupported(
            Some("timeout"),
            Some(format!(
                "querying launcher capabilities timed out after {}s",
                CAPABILITIES_TIMEOUT.as_secs()
            )),
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    match output.status.code() {
        Some(0) => {}
        // The launcher predates this mode. Not an error: the caller degrades.
        Some(EXIT_INVALID_LAUNCHER_MODE) => return Ok(unsupported(None, None)),
        Some(EXIT_COMMAND_NOT_FOUND) => {
            let (_, error_code, message) =
                classify_transport_failure(Some(EXIT_COMMAND_NOT_FOUND), &stderr, launcher_path);
            return Ok(unsupported(Some(error_code), Some(message)));
        }
        code => {
            let (_, error_code, message) = classify_transport_failure(code, &stderr, launcher_path);
            return Ok(unsupported(Some(error_code), Some(message)));
        }
    }

    // Last nonempty line: a login shell may print a banner ahead of the answer.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Some(line) = stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
    else {
        return Ok(unsupported(None, None));
    };
    let Ok(reply) = serde_json::from_str::<CapabilitiesReply>(line) else {
        // Answered, but not in a shape this build understands. Degrade rather
        // than fail: a future launcher must never be able to break an old
        // desktop by adding to its own reply.
        return Ok(unsupported(None, None));
    };
    let mut capabilities: Vec<String> = reply
        .capabilities
        .into_iter()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= MAX_CAPABILITY_NAME_BYTES
                && !name.chars().any(char::is_control)
        })
        .take(MAX_CAPABILITY_ENTRIES)
        .collect();
    capabilities.sort();
    capabilities.dedup();
    Ok(LauncherCapabilities {
        host: host.to_owned(),
        launcher_path: launcher_path.to_owned(),
        launcher_protocol_version: reply.launcher_protocol_version,
        launcher_revision: reply.launcher_revision,
        status_version: reply.status_version,
        capabilities,
        supports_capability_query: true,
        error_code: None,
        error: None,
    })
}

fn validate_workspace_hash(hash: &str) -> Result<(), String> {
    let hex = hash
        .strip_prefix(WORKSPACE_HASH_PREFIX)
        .ok_or("remote workspace hash is invalid")?;
    if hex.len() != WORKSPACE_HASH_HEX_LEN
        || !hex.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("remote workspace hash is invalid".into());
    }
    Ok(())
}

fn ssh_workspace_spec(
    profile: &RemotePiProfile,
    operation: &str,
    path: &str,
    encoding: Option<&str>,
    to: Option<&str>,
    expected_hash: Option<Option<&str>>,
) -> Result<LaunchSpec, String> {
    validate_profile(profile)?;
    if !WORKSPACE_OPERATIONS.contains(&operation) {
        return Err(format!("unsupported remote workspace operation `{operation}`"));
    }
    if let Some(encoding) = encoding {
        if !WORKSPACE_ENCODINGS.contains(&encoding) {
            return Err(format!("unsupported remote workspace encoding `{encoding}`"));
        }
    }
    // Validated here as well as in the launcher: the desktop must not put a
    // malformed path on the wire, and the launcher must not trust one it is handed.
    validate_remote_path(path, "remote workspace path")?;
    match (operation, to) {
        ("rename", Some(destination)) => validate_remote_path(destination, "remote rename target")?,
        ("rename", None) => return Err("rename requires a destination path".into()),
        (_, Some(_)) => return Err(format!("`{operation}` takes no destination path")),
        (_, None) => {}
    }
    if let Some(Some(hash)) = expected_hash {
        validate_workspace_hash(hash)?;
    }
    let payload = WorkspacePayload {
        protocol_version: LAUNCHER_PROTOCOL_VERSION,
        operation,
        path,
        encoding,
        to,
        expected_hash,
    };
    let encoded = STANDARD.encode(
        serde_json::to_vec(&payload).map_err(|e| format!("encode workspace payload: {e}"))?,
    );
    Ok(ssh_spec_for(
        &profile.ssh_host,
        &profile.launcher_path,
        "--workspace",
        &encoded,
    ))
}

/// What `--status` reports about one task, as the desktop sees it.
///
/// These are **process** states, observed from the same host as pi. The four *connection*
/// states the UI shows — `running` / `lost` / `exited` / `orphaned` — are derived on the
/// desktop side, because `lost` and `orphaned` describe the channel, which a launcher
/// standing next to pi cannot see.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTaskReport {
    pub remote_task_id: String,
    pub state: String,
    /// `true` when the death was never witnessed — the supervisor was gone when asked.
    pub stale: bool,
    pub exists: bool,
    pub pid: Option<i64>,
    pub pi_alive: bool,
    pub exit_code: Option<i64>,
    pub stop_requested_at: Option<i64>,
    pub stop_confirmed_at: Option<i64>,
    pub base_sequence: Option<u64>,
    pub next_sequence: Option<u64>,
}

/// Ask the host what a task is doing.
///
/// The desktop cannot infer this: a partitioned pi stays alive for up to ~2h after the
/// local transport gives up at 24.2s, so guessing is wrong for exactly as long as it
/// matters. This is the only way to tell `lost` from `exited`.
#[tauri::command]
pub async fn remote_task_status(
    profile_id: String,
    remote_task_id: String,
) -> Result<RemoteTaskReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = load_profile(&profile_id)?;
        validate_remote_task_id(&remote_task_id)?;
        let spec = ssh_task_spec(&profile, RemoteTaskMode::Status, Some(&remote_task_id))?;
        let reply = one_line_reply(&spec, WORKSPACE_TIMEOUT, &profile.launcher_path)?;
        if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            // A spent id is a normal answer, not a failure — the conversation simply has
            // no live task any more.
            if reply.get("errorCode").and_then(serde_json::Value::as_str) == Some("taskNotFound") {
                return Ok(RemoteTaskReport {
                    remote_task_id,
                    state: "exited".into(),
                    stale: false,
                    exists: false,
                    pid: None,
                    pi_alive: false,
                    exit_code: None,
                    stop_requested_at: None,
                    stop_confirmed_at: None,
                    base_sequence: None,
                    next_sequence: None,
                });
            }
            return Err(format!(
                "remote task status failed: {}",
                reply
                    .get("errorCode")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unreadable reply")
            ));
        }
        Ok(task_report(&remote_task_id, &reply))
    })
    .await
    .map_err(|error| format!("remote task status failed: {error}"))?
}

/// Stop the remote task itself — not the channel to it.
///
/// Deliberately separate from `pi_stop`, which on a detached target only closes the local
/// attach. Those are two different intents: "I am done looking at this" versus "stop
/// working". Conflating them would make every window close kill remote work, which is the
/// exact opposite of why detached mode exists.
#[tauri::command]
pub async fn remote_task_stop(
    profile_id: String,
    remote_task_id: String,
) -> Result<RemoteTaskReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = load_profile(&profile_id)?;
        validate_remote_task_id(&remote_task_id)?;
        let spec = ssh_task_spec(&profile, RemoteTaskMode::Stop, Some(&remote_task_id))?;
        // Up to a 5s stop-confirmation wait on the far side, plus the round trip.
        let reply = one_line_reply(&spec, STOP_TIMEOUT, &profile.launcher_path)?;
        if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            let code = reply
                .get("errorCode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("remoteStopFailed");
            // Stopping something already gone is the desired end state, not an error.
            if code == "taskNotFound" {
                return Ok(RemoteTaskReport {
                    remote_task_id,
                    state: "exited".into(),
                    stale: false,
                    exists: false,
                    pid: None,
                    pi_alive: false,
                    exit_code: None,
                    stop_requested_at: None,
                    stop_confirmed_at: None,
                    base_sequence: None,
                    next_sequence: None,
                });
            }
            return Err(code.to_owned());
        }
        Ok(task_report(&remote_task_id, &reply))
    })
    .await
    .map_err(|error| format!("remote task stop failed: {error}"))?
}

/// Opportunistic housekeeping: reap orphans and expired task directories.
///
/// Called alongside other work rather than on a timer, because acceptance showed orphans
/// only happen on a real network partition — a rare, cold path. A resident reaper would be
/// machinery for an event that almost never fires.
#[tauri::command]
pub async fn remote_task_reap(profile_id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = load_profile(&profile_id)?;
        let spec = ssh_task_spec(&profile, RemoteTaskMode::Reap, None)?;
        one_line_reply(&spec, WORKSPACE_TIMEOUT, &profile.launcher_path)
    })
    .await
    .map_err(|error| format!("remote task reap failed: {error}"))?
}

fn task_report(remote_task_id: &str, reply: &serde_json::Value) -> RemoteTaskReport {
    let task = reply.get("task").unwrap_or(&serde_json::Value::Null);
    let number = |key: &str| task.get(key).and_then(serde_json::Value::as_i64);
    let sequence = |key: &str| {
        task.get("journal")
            .and_then(|journal| journal.get(key))
            .and_then(serde_json::Value::as_u64)
    };
    RemoteTaskReport {
        remote_task_id: remote_task_id.to_owned(),
        state: task
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("exited")
            .to_owned(),
        stale: task
            .get("stale")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        exists: true,
        pid: number("pid"),
        pi_alive: task
            .get("piAlive")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        exit_code: number("exitCode"),
        stop_requested_at: number("stopRequestedAt"),
        stop_confirmed_at: number("stopConfirmedAt"),
        base_sequence: sequence("baseSequence"),
        next_sequence: sequence("nextSequence"),
    }
}

/// One line into a detached task's stdin, through `--send`.
///
/// `idempotency_key` is opt-in and the reason `--send` is more than a pipe: a disconnect
/// at the measured 24.2s detection window tells the desktop nothing about whether the
/// write landed, so retrying blind duplicates a turn and not retrying loses one. With a
/// key, the launcher recognises the replay and does not forward it twice.
///
/// A duplicate is **success**, not an error: the caller's intent — "this message reached
/// pi exactly once" — is satisfied either way.
pub fn send_to_remote_task(
    profile_id: &str,
    remote_task_id: &str,
    line: &str,
    idempotency_key: Option<&str>,
) -> Result<(), String> {
    let profile = load_profile(profile_id)?;
    if profile.lifecycle != LIFECYCLE_DETACHED {
        return Err("remote send requires a detached remote profile".into());
    }
    validate_remote_task_id(remote_task_id)?;
    let spec = ssh_task_spec(&profile, RemoteTaskMode::Send, Some(remote_task_id))?;
    // pi reads newline-delimited JSON, and the launcher forwards stdin verbatim, so the
    // terminator has to be here rather than assumed downstream.
    let body = match idempotency_key {
        Some(key) => {
            if key.is_empty() || key.len() > 128 || !key.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')
            }) {
                return Err("remote send idempotency key is invalid".into());
            }
            serde_json::to_string(&serde_json::json!({
                "idempotencyKey": key,
                "payload": format!("{line}\n"),
            }))
            .map_err(|error| format!("encode send envelope: {error}"))?
        }
        None => format!("{line}\n"),
    };
    let output = run_bounded_command(
        &spec,
        WORKSPACE_TIMEOUT,
        Some(&body),
        PREFLIGHT_OUTPUT_MAX_BYTES,
    )?;
    if output.timed_out {
        return Err("remote send timed out".into());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.status.code() != Some(0) {
        let (_, error_code, message) =
            classify_transport_failure(output.status.code(), &stderr, &profile.launcher_path);
        return Err(format!("{error_code}: {message}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("remote send returned no reply")?;
    let reply: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|error| format!("invalid send reply: {error}"))?;
    if reply.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(());
    }
    let code = reply
        .get("errorCode")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("remoteSendFailed");
    Err(code.to_owned())
}

/// The launcher's `--status` reply for one task, reduced to what the desktop acts on.
struct RemoteTaskStatus {
    state: String,
    pid: Option<i64>,
    supervisor_pid: Option<i64>,
    started_at: Option<i64>,
    base_sequence: Option<u64>,
    next_sequence: Option<u64>,
}

/// `--status <id>`. `Ok(None)` means the task genuinely does not exist — distinct from
/// an error, because a spent id and an unreachable host need different handling.
fn read_remote_task(
    profile: &RemotePiProfile,
    task_id: &str,
) -> Result<Option<RemoteTaskStatus>, String> {
    let spec = ssh_task_spec(profile, RemoteTaskMode::Status, Some(task_id))?;
    let reply = one_line_reply(&spec, WORKSPACE_TIMEOUT, &profile.launcher_path)?;
    if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return match reply.get("errorCode").and_then(serde_json::Value::as_str) {
            Some("taskNotFound") => Ok(None),
            Some(code) => Err(format!("remote task status failed: {code}")),
            None => Err("remote task status returned an unreadable reply".into()),
        };
    }
    let task = reply
        .get("task")
        .ok_or("remote task status reply had no task")?;
    let number = |key: &str| task.get(key).and_then(serde_json::Value::as_i64);
    let sequence = |key: &str| {
        task.get("journal")
            .and_then(|journal| journal.get(key))
            .and_then(serde_json::Value::as_u64)
    };
    Ok(Some(RemoteTaskStatus {
        state: task
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("exited")
            .to_owned(),
        pid: number("pid"),
        supervisor_pid: number("supervisorPid"),
        started_at: number("startedAt"),
        base_sequence: sequence("baseSequence"),
        next_sequence: sequence("nextSequence"),
    }))
}

/// Runs one launcher mode and parses its single JSON reply line.
///
/// Every task mode answers with exactly one line and exit 0 even on failure, so a
/// nonzero status is the transport or a launcher too old to know the mode.
fn one_line_reply(
    spec: &LaunchSpec,
    timeout: Duration,
    launcher_path: &str,
) -> Result<serde_json::Value, String> {
    let output = run_bounded_command(spec, timeout, None, PREFLIGHT_OUTPUT_MAX_BYTES)?;
    if output.timed_out {
        return Err(format!(
            "remote task command timed out after {}s",
            timeout.as_secs()
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.status.code() != Some(0) {
        let (_, error_code, message) =
            classify_transport_failure(output.status.code(), &stderr, launcher_path);
        return Err(format!("{error_code}: {message}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Last nonempty line: a login shell may print a banner ahead of the answer.
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("remote task command returned no reply")?;
    serde_json::from_str(line.trim()).map_err(|error| format!("invalid task reply: {error}"))
}

/// `t-` plus 12 hex chars, which satisfies the launcher's `^[a-z0-9][a-z0-9-]{7,63}$`.
///
/// Random rather than sequential: ids are minted on two sides of a network and a
/// collision would mean two conversations sharing one journal.
fn mint_remote_task_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    format!("t-{:08x}{:04x}", millis & 0xffff_ffff, nanos & 0xffff)
}

/// What a detached task looks like to the desktop after `remote_task_ensure`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTaskHandle {
    /// The id to put on the binding and persist with the conversation.
    pub remote_task_id: String,
    /// `starting` | `running` | `stopping` | `exited`, from the launcher.
    pub state: String,
    pub pid: Option<i64>,
    pub supervisor_pid: Option<i64>,
    pub started_at: Option<i64>,
    /// Set when this call had to mint a new id because the previous task was dead.
    ///
    /// One `remoteTaskId` is one remote pi process for its whole life, so continuing
    /// after pi exits means a new id — and a caller holding a cursor into the old
    /// journal has to know its transcript does not continue here.
    pub previous_task_id: Option<String>,
    /// `true` when this call started the task rather than finding it alive.
    pub started: bool,
    /// Oldest sequence still in the journal, so a stale cursor is detectable up front.
    pub base_sequence: Option<u64>,
    pub next_sequence: Option<u64>,
}

/// Mint or reattach a detached task, so `pi_start` only ever has to spawn the attach.
///
/// Kept out of `pi_start` because this is the part that talks to the host: two bounded
/// SSH round trips, ~2.5s measured. `pi_start` is a synchronous command holding the
/// runtime mutex, and blocking it for that long would stall every other task.
///
/// Three cases, one entry point:
/// - no id ⇒ mint one and `--start-detached`
/// - id, alive ⇒ return it untouched, for a reattach
/// - id, dead ⇒ mint a new one with `previous_task_id` set, and start that
#[tauri::command]
pub async fn remote_task_ensure(
    profile_id: String,
    remote_task_id: Option<String>,
    remote_cwd: String,
    resume_path: Option<String>,
) -> Result<RemoteTaskHandle, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_remote_task(
            &profile_id,
            remote_task_id.as_deref(),
            &remote_cwd,
            resume_path.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("remote task setup failed: {error}"))?
}

fn ensure_remote_task(
    profile_id: &str,
    remote_task_id: Option<&str>,
    remote_cwd: &str,
    resume_path: Option<&str>,
) -> Result<RemoteTaskHandle, String> {
    let profile = load_profile(profile_id)?;
    if profile.lifecycle != LIFECYCLE_DETACHED {
        return Err("remote task setup requires a detached remote profile".into());
    }
    validate_remote_path(remote_cwd, "remote workspace")?;

    let mut previous_task_id = None;
    let mut task_id = match remote_task_id {
        Some(existing) => {
            validate_remote_task_id(existing)?;
            let status = read_remote_task(&profile, existing)?;
            match status {
                // Alive: reattach to exactly this task. Starting a second pi over one
                // journal is the V1 defect this whole id rule exists to prevent.
                Some(task) if task.state != "exited" => {
                    return Ok(RemoteTaskHandle {
                        remote_task_id: existing.to_owned(),
                        state: task.state,
                        pid: task.pid,
                        supervisor_pid: task.supervisor_pid,
                        started_at: task.started_at,
                        previous_task_id: None,
                        started: false,
                        base_sequence: task.base_sequence,
                        next_sequence: task.next_sequence,
                    });
                }
                // Dead, or gone entirely: the id is spent either way.
                _ => {
                    previous_task_id = Some(existing.to_owned());
                    mint_remote_task_id()
                }
            }
        }
        None => mint_remote_task_id(),
    };
    task_id = task_id.trim().to_owned();
    validate_remote_task_id(&task_id)?;

    let binding = ExecutionBinding::Ssh {
        profile_id: profile.id.clone(),
        profile_revision: profile.revision,
        host_alias: profile.ssh_host.clone(),
        remote_cwd: remote_cwd.to_owned(),
        launcher_protocol_version: profile.launcher_protocol_version,
        remote_task_id: Some(task_id.clone()),
    };
    let spec = ssh_start_detached_spec(&profile, &binding, resume_path)?;
    let reply = one_line_reply(&spec, WORKSPACE_TIMEOUT, &profile.launcher_path)?;
    if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let code = reply
            .get("errorCode")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("taskStartFailed");
        let detail = reply
            .get("detail")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        return Err(format!("{code}{}{detail}", if detail.is_empty() { "" } else { ": " }));
    }
    let number = |key: &str| reply.get(key).and_then(serde_json::Value::as_i64);
    Ok(RemoteTaskHandle {
        remote_task_id: task_id,
        state: reply
            .get("state")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("running")
            .to_owned(),
        pid: number("pid"),
        supervisor_pid: number("supervisorPid"),
        started_at: number("startedAt"),
        previous_task_id,
        started: true,
        // A task that has just started has an empty journal, so the first attach starts
        // from the beginning and no cursor can be stale.
        base_sequence: Some(1),
        next_sequence: Some(1),
    })
}

/// One workspace request against a stored profile.
///
/// Gate reads on `hasLauncherCapability(probe, "workspace-v1")` and writes on
/// `"workspace-writes-v1"`: a launcher that predates a mode answers `invalid launcher
/// mode` with exit 64, and the desktop should offer a reinstall rather than surface a
/// transport error.
///
/// `expected_hash` is `Option<Option<String>>` on purpose — see `WorkspacePayload`.
/// Serde maps a missing field to `None` and an explicit `null` to `Some(None)`, which
/// is exactly the distinction a hash-checked write depends on.
#[tauri::command]
pub fn remote_workspace_request(
    id: String,
    operation: String,
    path: String,
    encoding: Option<String>,
    to: Option<String>,
    expected_hash: Option<Option<String>>,
    body: Option<String>,
) -> Result<RemoteWorkspaceReply, String> {
    let profile = load_profile(&id)?;
    // A body belongs to `write` and to nothing else. Accepting one elsewhere would
    // leave a caller believing content was stored when the launcher ignored it.
    match (operation.as_str(), body.as_deref()) {
        ("write", None) => return Err("a remote write requires a body".into()),
        ("write", Some(content)) if content.len() > WORKSPACE_BODY_MAX_BYTES => {
            return Err("remote write body exceeded its size limit".into());
        }
        ("write", Some(_)) => {}
        (other, Some(_)) => return Err(format!("`{other}` takes no body")),
        (_, None) => {}
    }
    if !WORKSPACE_WRITE_OPERATIONS.contains(&operation.as_str()) && expected_hash.is_some() {
        return Err(format!("`{operation}` takes no expected hash"));
    }
    let spec = ssh_workspace_spec(
        &profile,
        &operation,
        &path,
        encoding.as_deref(),
        to.as_deref(),
        expected_hash.as_ref().map(|hash| hash.as_deref()),
    )?;
    let output = run_bounded_command(
        &spec,
        WORKSPACE_TIMEOUT,
        body.as_deref(),
        WORKSPACE_OUTPUT_MAX_BYTES,
    )?;
    if output.timed_out {
        return Err(format!(
            "remote workspace request timed out after {}s",
            WORKSPACE_TIMEOUT.as_secs()
        ));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    // The launcher answers every workspace outcome with exit 0 and one JSON line, so
    // a nonzero status is the transport or a launcher too old to know the mode.
    if output.status.code() != Some(0) {
        let (_, error_code, message) =
            classify_transport_failure(output.status.code(), &stderr, &profile.launcher_path);
        return Err(format!("{error_code}: {message}"));
    }
    if output.stdout.len() > WORKSPACE_OUTPUT_MAX_BYTES {
        return Err("remote workspace reply exceeded its size limit".into());
    }
    // Last nonempty line: a login shell may print a banner ahead of the answer.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .ok_or("remote workspace request returned no reply")?;
    serde_json::from_str(line.trim()).map_err(|error| format!("invalid workspace reply: {error}"))
}

/// Capability probe for a stored profile.
#[tauri::command]
pub fn remote_profile_capabilities(id: String) -> Result<LauncherCapabilities, String> {    let profile = load_profile(&id)?;
    probe_launcher_capabilities(&profile.ssh_host, &profile.launcher_path)
}

fn ssh_options() -> &'static [&'static str] {
    &[
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "NumberOfPasswordPrompts=0",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "RemoteCommand=none",
        "-o",
        "EscapeChar=none",
        "-o",
        SSH_CONNECT_TIMEOUT_OPTION,
        "-o",
        SSH_SERVER_ALIVE_INTERVAL_OPTION,
        "-o",
        SSH_SERVER_ALIVE_COUNT_OPTION,
        "-o",
        "RequestTTY=no",
    ]
}

/// Quote one remote-shell argument. The local process still uses argv; this is
/// needed because OpenSSH joins command arguments before sending them remotely.
pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Checks a stored profile. Used by the execution-target picker before it
/// switches a conversation over.
#[tauri::command]
pub fn remote_profile_preflight(id: String) -> Result<RemoteReadinessReport, String> {
    validate_profile_id(&id)?;
    let profile = load_profile(&id)?;
    Ok(check_readiness(
        Some(profile.id.clone()),
        &profile.ssh_host,
        // Checked only when the profile carries a browse starting point. A profile
        // without one is still fully checkable — host readiness is what this answers,
        // and the workspace is validated when one is actually picked.
        profile.remote_cwd.as_deref(),
        &profile.launcher_path,
        profile.pi_executable.as_deref().unwrap_or("pi"),
        profile.launcher_protocol_version,
    ))
}

/// Checks an unsaved form draft, so the setup form can validate before it
/// persists anything. Field-shape errors come back as `Err`; anything the remote
/// host reports lands in the checklist instead.
#[tauri::command]
pub fn remote_profile_check_draft(
    profile: RemotePiProfileInput,
) -> Result<RemoteReadinessReport, String> {
    let launcher = launcher_or_default(profile.launcher_path.as_deref());
    let protocol_version = profile
        .launcher_protocol_version
        .unwrap_or(LAUNCHER_PROTOCOL_VERSION);
    let pi_executable = trimmed_option(profile.pi_executable.as_deref());
    let browse_directory = trimmed_option(profile.remote_cwd.as_deref());
    validate_host_alias(&profile.ssh_host)?;
    if let Some(directory) = browse_directory {
        validate_remote_path(directory, "remote browse directory")?;
    }
    validate_remote_path(launcher, "remote launcher")?;
    if protocol_version != LAUNCHER_PROTOCOL_VERSION {
        return Err(format!(
            "unsupported remote launcher protocol version {protocol_version}"
        ));
    }
    if let Some(id) = profile.id.as_deref() {
        validate_profile_id(id)?;
    }
    Ok(check_readiness(
        profile.id.clone(),
        &profile.ssh_host,
        browse_directory,
        launcher,
        pi_executable.unwrap_or("pi"),
        protocol_version,
    ))
}

/// Order the UI renders, and the order failures cascade in: a failed row leaves
/// everything below it unobserved rather than falsely green.
const CHECK_ORDER: [&str; 6] = [
    CHECK_SSH,
    CHECK_LAUNCHER,
    CHECK_NODE,
    CHECK_WORKSPACE,
    CHECK_PI,
    CHECK_PI_AUTH,
];

/// Host readiness, and — only when a workspace is already known — that workspace too.
///
/// `remote_cwd` is optional because a workspace is chosen per conversation rather than
/// stored on a profile, so a host has to be checkable before any directory has been
/// picked. With no cwd the launcher runs `pi --version` from `$HOME` and the workspace
/// row comes back `skipped`; the directory a user actually picks is validated at
/// open time through `remote_workspace_request`'s `stat`.
fn check_readiness(
    profile_id: Option<String>,
    host: &str,
    remote_cwd: Option<&str>,
    launcher_path: &str,
    pi_executable: &str,
    protocol_version: u32,
) -> RemoteReadinessReport {
    let mut report = RemoteReadinessReport {
        ok: false,
        profile_id,
        host: host.to_owned(),
        remote_cwd: remote_cwd.unwrap_or_default().to_owned(),
        launcher_path: launcher_path.to_owned(),
        pi_version: None,
        home: None,
        checks: Vec::new(),
    };

    let encoded =
        match encode_launcher_payload(remote_cwd, pi_executable, protocol_version, None, None) {
            Ok(value) => value,
            Err(error) => {
                report
                    .checks
                    .push(RemoteReadinessCheck::failed(CHECK_SSH, "invalid_payload", error));
                return finish_report(report);
            }
        };
    let spec = ssh_spec_for(host, launcher_path, "--preflight", &encoded);
    // Preflight owns stdout and expects exactly one small JSON document. Pi runs
    // use PiProcess instead, where stdout remains the Pi JSONL stream.
    let output = match run_bounded_command(&spec, PREFLIGHT_TIMEOUT, None, PREFLIGHT_OUTPUT_MAX_BYTES) {
        Ok(output) => output,
        Err(error) => {
            report
                .checks
                .push(RemoteReadinessCheck::failed(CHECK_SSH, "ssh_spawn_failed", error));
            return finish_report(report);
        }
    };

    if output.timed_out {
        report.checks.push(RemoteReadinessCheck::failed(
            CHECK_SSH,
            "ssh_timeout",
            format!("SSH did not answer within {}s", PREFLIGHT_TIMEOUT.as_secs()),
        ));
        return finish_report(report);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !output.status.success() {
        let (check, code, message) =
            classify_transport_failure(output.status.code(), &stderr, launcher_path);
        if check != CHECK_SSH {
            report
                .checks
                .push(RemoteReadinessCheck::ok(CHECK_SSH, Some(host.to_owned())));
        }
        report
            .checks
            .push(RemoteReadinessCheck::failed(check, code, message));
        return finish_report(report);
    }

    // SSH connected, the launcher ran, and node executed it far enough to speak.
    report
        .checks
        .push(RemoteReadinessCheck::ok(CHECK_SSH, Some(host.to_owned())));
    report.checks.push(RemoteReadinessCheck::ok(
        CHECK_LAUNCHER,
        Some(launcher_path.to_owned()),
    ));

    if output.stdout.len() > PREFLIGHT_OUTPUT_MAX_BYTES {
        report.checks.push(RemoteReadinessCheck::failed(
            CHECK_NODE,
            "invalid_response",
            "remote preflight response exceeded 64 KiB".into(),
        ));
        return finish_report(report);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) else {
        report.checks.push(RemoteReadinessCheck::failed(
            CHECK_NODE,
            "invalid_response",
            if stderr.is_empty() {
                "remote preflight returned non-JSON output".into()
            } else {
                stderr
            },
        ));
        return finish_report(report);
    };

    let field = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    };
    // Show the interpreter path next to the version: when the launcher had to
    // recover node from a login shell (nvm and friends), that is the only visible
    // sign of it, and it explains why the same host fails a bare `ssh host node`.
    report.checks.push(RemoteReadinessCheck::ok(
        CHECK_NODE,
        match (field("nodeVersion"), field("nodePath")) {
            (Some(version), Some(path)) => Some(format!("{version} · {path}")),
            (Some(version), None) => Some(version),
            (None, path) => path,
        },
    ));

    if value
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        // Only reported when a workspace was actually part of the request. With none,
        // the row stays `skipped` — claiming a directory is fine when none was checked
        // is exactly the kind of false green this split exists to remove.
        match remote_cwd {
            Some(cwd) => report
                .checks
                .push(RemoteReadinessCheck::ok(CHECK_WORKSPACE, Some(cwd.to_owned()))),
            None => report.checks.push(RemoteReadinessCheck::skipped(CHECK_WORKSPACE)),
        }
        report.home = field("home");
        report.pi_version = field("piVersion");
        report
            .checks
            .push(RemoteReadinessCheck::ok(CHECK_PI, report.pi_version.clone()));
        match value.get("piAuthConfigured").and_then(serde_json::Value::as_bool) {
            Some(true) => report.checks.push(RemoteReadinessCheck::ok(CHECK_PI_AUTH, None)),
            Some(false) => report.checks.push(RemoteReadinessCheck::warning(
                CHECK_PI_AUTH,
                "pi_auth_missing",
                "no credentials found in the remote pi config".into(),
            )),
            // Launcher predates the check — say nothing rather than guess.
            None => report.checks.push(RemoteReadinessCheck::skipped(CHECK_PI_AUTH)),
        }
        return finish_report(report);
    }

    let (check, code) = classify_launcher_failure(field("errorCode").as_deref());
    report.checks.push(RemoteReadinessCheck::failed(
        check,
        code,
        field("error").unwrap_or_else(|| "remote preflight failed".into()),
    ));
    finish_report(report)
}

/// Fills unreached rows and derives `ok`. The pi-auth warning does not block:
/// a config file is weak evidence and a false negative must not stop a switch.
fn finish_report(mut report: RemoteReadinessReport) -> RemoteReadinessReport {
    for id in CHECK_ORDER {
        if !report.checks.iter().any(|check| check.id == id) {
            report.checks.push(RemoteReadinessCheck::skipped(id));
        }
    }
    report
        .checks
        .sort_by_key(|check| CHECK_ORDER.iter().position(|id| *id == check.id).unwrap_or(usize::MAX));
    report.ok = report.checks.iter().all(|check| match check.id {
        CHECK_PI_AUTH => check.status != "failed",
        _ => check.status == "ok",
    });
    report
}

/// Splits a nonzero `ssh` exit into "SSH could not connect" versus "SSH
/// connected but the remote side could not start", which are fixed in different
/// places. OpenSSH reports 255 for its own failures and otherwise forwards the
/// remote exit code, so stderr is the only reliable discriminator.
fn classify_transport_failure(
    code: Option<i32>,
    stderr: &str,
    launcher_path: &str,
) -> (&'static str, &'static str, String) {
    let lower = stderr.to_ascii_lowercase();
    let described = || {
        if stderr.is_empty() {
            match code {
                Some(value) => format!("ssh exited with {value}"),
                None => "ssh was terminated by a signal".to_owned(),
            }
        } else {
            stderr.to_owned()
        }
    };

    // A launcher installed before a mode existed rejects it in the shell preamble
    // with exactly `invalid launcher mode` and exit 64. Every profile enrolled
    // before V2 is in that state for `--workspace`, `--attach` and the task modes,
    // so this is the first branch a real user hits after an app update. Without it
    // the failure falls through to `ssh_failed` and sends the user off to debug a
    // connection that is working perfectly — the actual fix is one reinstall.
    //
    // Both halves of the guard matter: exit 64 alone is also how the current
    // launcher reports malformed arguments, which is a bug on this side rather
    // than an out-of-date host.
    if code == Some(EXIT_INVALID_LAUNCHER_MODE) && lower.contains("invalid launcher mode") {
        return (CHECK_LAUNCHER, "launcher_mode_unsupported", described());
    }
    if lower.contains("permission denied (publickey")
        || lower.contains("no supported authentication methods")
        || lower.contains("too many authentication failures")
        || lower.contains("authentications that can continue")
    {
        return (CHECK_SSH, "ssh_auth_failed", described());
    }
    if lower.contains("host key verification failed")
        || lower.contains("remote host identification has changed")
    {
        return (CHECK_SSH, "ssh_host_key", described());
    }
    if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname")
    {
        return (CHECK_SSH, "ssh_host_unknown", described());
    }
    if lower.contains("connection refused")
        || lower.contains("connection timed out")
        || lower.contains("network is unreachable")
        || lower.contains("no route to host")
        || lower.contains("operation timed out")
    {
        return (CHECK_SSH, "ssh_unreachable", described());
    }
    if lower.contains("node: not found")
        || lower.contains("node: command not found")
        || (lower.contains("node") && lower.contains("not found"))
    {
        return (CHECK_NODE, "node_missing", described());
    }
    // The remote shell reports the launcher path it could not run.
    if lower.contains(&launcher_path.to_ascii_lowercase()) || code == Some(127) {
        let code = if lower.contains("permission denied") {
            "launcher_not_executable"
        } else {
            "launcher_missing"
        };
        return (CHECK_LAUNCHER, code, described());
    }
    (CHECK_SSH, "ssh_failed", described())
}

pub(crate) fn ssh_transport_error_code(
    exit_code: Option<i32>,
    stderr: &str,
    launcher_path: &str,
) -> &'static str {
    classify_transport_failure(exit_code, stderr, launcher_path).1
}

/// Maps a launcher-reported `errorCode` onto the row that owns it.
fn classify_launcher_failure(error_code: Option<&str>) -> (&'static str, &'static str) {
    match error_code {
        Some("workspace_missing") => (CHECK_WORKSPACE, "workspace_missing"),
        Some("workspace_unavailable") => (CHECK_WORKSPACE, "workspace_unavailable"),
        Some("pi_not_found") => (CHECK_PI, "pi_not_found"),
        Some("pi_timeout") => (CHECK_PI, "pi_timeout"),
        Some("pi_unavailable") => (CHECK_PI, "pi_unavailable"),
        // The launcher validates the workspace before it touches pi, so an
        // unrecognized code got past that and is a pi-side problem.
        _ => (CHECK_PI, "preflight_failed"),
    }
}

/// What an auto-upgrade decided, and why.
///
/// Every variant is a *reported* outcome rather than an error, because none of them
/// is a fault the user has to act on immediately: an old launcher still runs V1, and
/// a host that cannot be reached will be retried. Only `Failed` names something broken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UpgradeDecision {
    /// Revisions match. Nothing to do — the overwhelmingly common case.
    AlreadyCurrent,
    /// The host is behind and nothing is at risk. Replace the file.
    Upgrade,
    /// Behind, but replacing the file would strand a live task whose `status.json`
    /// this build's launcher would refuse to read. The task outlives the upgrade
    /// either way, so waiting costs nothing and upgrading costs the task.
    BlockedByLiveTasks,
    /// The host's launcher is *newer* than ours. Never overwrite: this is an older
    /// desktop meeting a host some newer desktop already upgraded, and a downgrade
    /// would take working features away from that other desktop.
    RemoteIsNewer,
}

/// Decides an upgrade from facts alone, so the policy is testable without a host.
///
/// An unreported `remote_revision` is `0`, which means "older than every build that
/// reports one" — *not* "unknown, leave alone". Skipping those would make this feature
/// a no-op on exactly the hosts it exists for: every profile enrolled before revisions
/// existed reports 0, and those are the ones running dead modes. The file at the
/// profile's `launcherPath` got there because this app put it there, so replacing it is
/// replacing our own artifact.
///
/// `supports_tasks` is what keeps that from stranding anything. A launcher without
/// `detached-tasks-v1` cannot have tasks *by construction* — the feature did not exist —
/// so it needs no count and must not be blocked by the fact that it cannot answer
/// `--status`. Only a host that does support tasks has to be counted, and there an
/// unestablished count blocks, because one status file this host cannot parse aborts the
/// entire listing: "cannot count" is evidence of the problem the gate exists for, never
/// evidence of an idle host.
pub(crate) fn decide_upgrade(
    supports_capability_query: bool,
    remote_revision: u32,
    remote_status_version: u32,
    supports_tasks: bool,
    live_tasks: Option<u32>,
) -> UpgradeDecision {
    if remote_revision > LAUNCHER_REVISION {
        return UpgradeDecision::RemoteIsNewer;
    }
    // Equality only counts when the host actually answered. A launcher too old for the
    // query reports 0 for everything, and must never be read as current just because
    // this build's revision happens to be 0 too.
    if supports_capability_query && remote_revision == LAUNCHER_REVISION {
        return UpgradeDecision::AlreadyCurrent;
    }
    // Behind. Safe outright when this build reads the state the host already wrote.
    if remote_status_version == LAUNCHER_STATUS_VERSION {
        return UpgradeDecision::Upgrade;
    }
    // The state format would change. Nothing can be stranded on a launcher that has no
    // task support at all, so that upgrades freely.
    if !supports_tasks {
        return UpgradeDecision::Upgrade;
    }
    match live_tasks {
        Some(0) => UpgradeDecision::Upgrade,
        _ => UpgradeDecision::BlockedByLiveTasks,
    }
}

/// Reported back so the UI can say what happened without re-deriving it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherUpgradeResult {
    pub host: String,
    pub launcher_path: String,
    /// `already_current` / `upgraded` / `blocked_by_live_tasks` / `remote_is_newer`
    /// / `unreachable`.
    pub outcome: String,
    /// What the host reported before anything was replaced. `0` when unknown.
    pub previous_revision: u32,
    /// This build's revision, so a caller can show `4 → 7` without a second source.
    pub current_revision: u32,
    /// Only set when the outcome is `blocked_by_live_tasks`, and `None` when the
    /// count itself could not be established.
    pub live_tasks: Option<u32>,
    /// Set when the probe could not run at all. The outcome is then `unreachable`.
    pub error: Option<String>,
}

/// Counts tasks that have not exited, using the launcher **already installed** on the
/// host — which is the only build that can read its own state format.
///
/// `None` means the count could not be established: either the transport failed or the
/// launcher answered `ok:false`, which is what a status file it cannot parse produces.
/// The caller must treat that as blocking, never as zero.
fn count_live_tasks(profile: &RemotePiProfile) -> Option<u32> {
    let spec = ssh_task_spec(profile, RemoteTaskMode::Status, None).ok()?;
    let reply = one_line_reply(&spec, WORKSPACE_TIMEOUT, &profile.launcher_path).ok()?;
    if reply.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return None;
    }
    let tasks = reply.get("tasks").and_then(serde_json::Value::as_array)?;
    Some(
        tasks
            .iter()
            .filter(|task| {
                task.get("state").and_then(serde_json::Value::as_str) != Some("exited")
            })
            .count() as u32,
    )
}

/// Brings one host's launcher up to this build, when that is safe.
///
/// Idempotent and cheap to call: the common answer is `already_current` after a single
/// bounded `--capabilities` round trip. It exists because a launcher mode that a host
/// predates is *dead* on that host until someone reinstalls, and until now nothing
/// detected that — the capability handshake had no callers at all, so every new mode
/// failed at the point of use instead of at the point of connection.
#[tauri::command]
pub async fn remote_launcher_autoupgrade(id: String) -> Result<LauncherUpgradeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = load_profile(&id)?;
        let probe = probe_launcher_capabilities(&profile.ssh_host, &profile.launcher_path)?;
        let report = |outcome: &str, live_tasks: Option<u32>, error: Option<String>| {
            Ok(LauncherUpgradeResult {
                host: profile.ssh_host.clone(),
                launcher_path: profile.launcher_path.clone(),
                outcome: outcome.to_owned(),
                previous_revision: probe.launcher_revision,
                current_revision: LAUNCHER_REVISION,
                live_tasks,
                error,
            })
        };

        // A probe that failed for a reason the user must fix is not an upgrade
        // question. Reported rather than raised: the caller is on a path that has its
        // own work to do, and a dead host will fail that work with a better message.
        if let Some(error) = probe.error.clone() {
            return report("unreachable", None, Some(error));
        }

        let supports_tasks = probe
            .capabilities
            .iter()
            .any(|name| name == "detached-tasks-v1");
        let decide = |live_tasks| {
            decide_upgrade(
                probe.supports_capability_query,
                probe.launcher_revision,
                probe.status_version,
                supports_tasks,
                live_tasks,
            )
        };

        // Asked twice rather than pre-computing "is it behind": that ordering rule lives
        // in `decide_upgrade` and must not be restated here, where the copy would drift.
        // The first call assumes the worst about tasks, so it only lands on
        // `BlockedByLiveTasks` when the count is the one thing still in question — which
        // is also the only case worth a second round trip. Every other host, including
        // the common already-current one, stays a single probe.
        let mut live_tasks = None;
        let mut decision = decide(None);
        if decision == UpgradeDecision::BlockedByLiveTasks {
            live_tasks = count_live_tasks(&profile);
            decision = decide(live_tasks);
        }

        match decision {
            UpgradeDecision::AlreadyCurrent => report("already_current", None, None),
            UpgradeDecision::RemoteIsNewer => report("remote_is_newer", None, None),
            UpgradeDecision::BlockedByLiveTasks => {
                report("blocked_by_live_tasks", live_tasks, None)
            }
            UpgradeDecision::Upgrade => {
                // Same installer the button uses, so there is exactly one way the
                // launcher ever reaches a host: temp file, chmod, then `mv -f`, which
                // leaves a running supervisor on its own inode.
                match install_launcher_to(&profile.ssh_host, Some(&profile.launcher_path)) {
                    Ok(_) => report("upgraded", None, None),
                    Err(error) => report("unreachable", None, Some(error)),
                }
            }
        }
    })
    .await
    .map_err(|error| format!("remote launcher upgrade task failed: {error}"))?
}

/// Copies the embedded launcher to the remote host over the same SSH policy the
/// runtime uses, then reports the absolute path it landed on. Passing
/// `launcher_path: None` (or the `-` sentinel) resolves
/// `$HOME/.local/bin/pi-desktop-launcher`, which needs no sudo.
#[tauri::command]
pub fn remote_profile_install_launcher(
    host: String,
    launcher_path: Option<String>,
) -> Result<LauncherInstallResult, String> {
    install_launcher_to(&host, launcher_path.as_deref())
}

/// The install itself, shared by the button and the auto-upgrade.
///
/// Extracted rather than duplicated so there is exactly one way the launcher reaches a
/// host: two code paths writing to the same remote file would eventually disagree about
/// permissions or the atomic-replace discipline, and the failure would only show up as a
/// half-written launcher on somebody's server.
fn install_launcher_to(
    host: &str,
    launcher_path: Option<&str>,
) -> Result<LauncherInstallResult, String> {
    let host = host.to_owned();
    let launcher_path = launcher_path.map(str::to_owned);
    validate_host_alias(&host)?;
    let requested = match trimmed_option(launcher_path.as_deref()) {
        Some(path) => {
            validate_remote_path(path, "remote launcher")?;
            path.to_owned()
        }
        None => LAUNCHER_PATH_SENTINEL.to_owned(),
    };

    let mut spec = LaunchSpec::new("ssh");
    for &argument in ssh_options() {
        spec = spec.arg(argument);
    }
    // The installer travels as the `sh -c` script argument, not on stdin: `sh -s`
    // would consume stdin itself and leave the launcher body with nowhere to go.
    // With `-c`, `$0` is the label and `$1` is the requested path, and stdin stays
    // free for the `cat` that writes the launcher.
    let spec = spec
        .arg(host.clone())
        .arg("sh")
        .arg("-c")
        .arg(shell_quote(LAUNCHER_INSTALLER))
        .arg("pi-desktop-launcher-install")
        .arg(shell_quote(&requested));

    let output = run_bounded_command(&spec, INSTALL_TIMEOUT, Some(LAUNCHER_SOURCE), PREFLIGHT_OUTPUT_MAX_BYTES)?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if output.timed_out {
        return Err(format!(
            "installing the remote launcher timed out after {}s",
            INSTALL_TIMEOUT.as_secs()
        ));
    }
    if !output.status.success() {
        let (_, _, message) = classify_transport_failure(output.status.code(), &stderr, &requested);
        return Err(message);
    }
    // The installer's last stdout line is the absolute path it wrote.
    let resolved = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .next_back()
        .unwrap_or_default()
        .to_owned();
    validate_remote_path(&resolved, "remote launcher").map_err(|_| {
        if stderr.is_empty() {
            "the remote installer did not report a launcher path".to_owned()
        } else {
            stderr
        }
    })?;
    Ok(LauncherInstallResult {
        launcher_path: resolved,
        host,
    })
}

/// Runs on the remote host as a `sh -c` script with the launcher body on stdin
/// and the requested path (or `-`) as `$1`. Writes to a temporary file and
/// renames, so a launcher that is currently running is replaced rather than
/// truncated. Contains no single quotes: it is passed through `shell_quote`.
const LAUNCHER_INSTALLER: &str = r#"set -eu
target=${1:-}
if [ "$target" = "-" ] || [ -z "$target" ]; then
  target="${HOME:?HOME is not set on the remote host}/.local/bin/pi-desktop-launcher"
fi
case "$target" in
  /*) ;;
  *) printf "%s\n" "launcher path must be absolute" >&2; exit 64 ;;
esac
mkdir -p "$(dirname "$target")"
temporary="$target.tmp.$$"
cat > "$temporary"
chmod 0755 "$temporary"
mv -f "$temporary" "$target"
printf "%s\n" "$target"
"#;

/// Reads `Host` entries from the local `~/.ssh/config` so the form can offer a
/// list instead of a free-text field. Patterns and unusable aliases are skipped;
/// `Include` is not followed.
#[tauri::command]
pub fn ssh_config_hosts() -> Result<Vec<String>, String> {
    let path = crate::pi_settings::home_dir()?.join(".ssh").join("config");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut hosts = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Host").or_else(|| line.strip_prefix("host")) else {
            continue;
        };
        // Only `Host` itself — never `HostName`, `HostKeyAlias`, …
        if !rest.starts_with(|character: char| character.is_whitespace() || character == '=') {
            continue;
        }
        for alias in rest.trim_start_matches('=').split_whitespace() {
            if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                continue;
            }
            if validate_host_alias(alias).is_ok() && !hosts.iter().any(|item| item == alias) {
                hosts.push(alias.to_owned());
            }
        }
    }
    Ok(hosts)
}

struct BoundedCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    timed_out: bool,
}

/// Runs one short-lived `ssh` command with bounded output and a hard deadline.
/// `stdin_body` is written and the pipe closed before output is collected, which
/// is how the launcher installer receives the script body.
fn run_bounded_command(
    spec: &LaunchSpec,
    timeout: Duration,
    stdin_body: Option<&str>,
    max_output_bytes: usize,
) -> Result<BoundedCommandOutput, String> {
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .stdin(if stdin_body.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("ssh failed to start: {error}"))?;
    if let Some(body) = stdin_body {
        let mut stdin = child.stdin.take().ok_or("ssh stdin was unavailable")?;
        // Dropping the handle closes the pipe, which the remote `cat` needs.
        stdin
            .write_all(body.as_bytes())
            .map_err(|error| format!("cannot write to ssh stdin: {error}"))?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or("ssh stdout was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("ssh stderr was unavailable")?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take((max_output_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take((max_output_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });

    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("cannot poll ssh: {error}"))?
        {
            break (status, false);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child
                .wait()
                .map_err(|error| format!("cannot reap timed-out ssh: {error}"))?;
            break (status, true);
        }
        thread::sleep(Duration::from_millis(25));
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| "ssh stdout reader panicked".to_owned())?
        .map_err(|error| format!("cannot read ssh stdout: {error}"))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "ssh stderr reader panicked".to_owned())?
        .map_err(|error| format!("cannot read ssh stderr: {error}"))?;
    Ok(BoundedCommandOutput {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        classify_launcher_failure, classify_transport_failure, decide_upgrade, shell_quote,
        ssh_capabilities_spec, ssh_launch_spec, ssh_provider_sync_spec, ssh_start_detached_spec,
        ssh_task_spec, validate_binding, validate_profile_fields, validate_profile_id,
        validate_remote_task_id, CapabilitiesReply, ExecutionBinding, RemotePiProfile,
        RemoteTaskMode, UpgradeDecision, CHECK_LAUNCHER, CHECK_NODE, CHECK_PI, CHECK_SSH,
        CHECK_WORKSPACE, LAUNCHER_INSTALLER, LAUNCHER_REVISION, LAUNCHER_SOURCE,
        LAUNCHER_STATUS_VERSION,
    };
    use super::{ssh_attach_spec, ssh_workspace_spec, LaunchSpec, STANDARD};
    use base64::Engine as _;

    fn profile() -> RemotePiProfile {
        RemotePiProfile {
            id: "p1".into(),
            revision: 2,
            name: "Server".into(),
            ssh_host: "prod".into(),
            remote_cwd: Some("/srv/project with spaces".into()),
            pi_executable: None,
            launcher_path: "/opt/pi launcher".into(),
            launcher_protocol_version: 1,
            lifecycle: "attached".into(),
        }
    }

    fn binding(profile: &RemotePiProfile) -> ExecutionBinding {
        ExecutionBinding::Ssh {
            profile_id: profile.id.clone(),
            profile_revision: profile.revision,
            host_alias: profile.ssh_host.clone(),
            remote_cwd: profile.remote_cwd.clone().unwrap(),
            launcher_protocol_version: profile.launcher_protocol_version,
            remote_task_id: None,
        }
    }

    #[test]
    fn shell_quotes_single_quotes() {
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn rejects_unsafe_profile_identifiers_and_fields() {
        assert!(validate_profile_id("prod_01-west").is_ok());
        assert!(validate_profile_id("../prod").is_err());
        assert!(validate_profile_id("").is_err());

        assert!(validate_profile_fields(
            "Server",
            "prod.example",
            Some("/srv/project"),
            Some("pi"),
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_ok());
        assert!(validate_profile_fields(
            "Server",
            "-oProxyCommand=bad",
            Some("/srv/project"),
            None,
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_err());
        assert!(validate_profile_fields(
            "Server",
            "prod",
            Some("relative/project"),
            None,
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_err());
        assert!(validate_profile_fields(
            "Server",
            "prod",
            Some("/srv/project"),
            None,
            "/usr/local/bin/pi-desktop-launcher",
            2,
        )
        .is_err());
    }

    #[test]
    fn binding_requires_the_exact_profile_snapshot() {
        let profile = profile();
        let binding = binding(&profile);
        assert!(validate_binding(&profile, &binding).is_ok());

        let stale = ExecutionBinding::Ssh {
            profile_id: profile.id.clone(),
            profile_revision: profile.revision - 1,
            host_alias: profile.ssh_host.clone(),
            remote_cwd: profile.remote_cwd.clone().unwrap(),
            launcher_protocol_version: profile.launcher_protocol_version,
            remote_task_id: None,
        };
        assert!(validate_binding(&profile, &stale).is_err());

        let moved = ExecutionBinding::Ssh {
            profile_id: profile.id.clone(),
            profile_revision: profile.revision,
            host_alias: profile.ssh_host.clone(),
            remote_cwd: "/srv/other".into(),
            launcher_protocol_version: profile.launcher_protocol_version,
            remote_task_id: None,
        };
        assert!(validate_binding(&profile, &moved).is_err());
    }

    /// The checklist is only useful if each failure lands on the row whose fix
    /// text is correct, so the stderr patterns are pinned here.
    #[test]
    fn transport_failures_route_to_the_row_that_fixes_them() {
        let launcher = "/home/u/.local/bin/pi-desktop-launcher";
        let case = |stderr: &str, code: Option<i32>| {
            let (check, error_code, _) = classify_transport_failure(code, stderr, launcher);
            (check, error_code)
        };

        assert_eq!(
            case("prod: Permission denied (publickey).", Some(255)),
            (CHECK_SSH, "ssh_auth_failed")
        );
        assert_eq!(
            case("Host key verification failed.", Some(255)),
            (CHECK_SSH, "ssh_host_key")
        );
        assert_eq!(
            case("ssh: Could not resolve hostname prod", Some(255)),
            (CHECK_SSH, "ssh_host_unknown")
        );
        assert_eq!(
            case("connect to host prod port 22: Connection refused", Some(255)),
            (CHECK_SSH, "ssh_unreachable")
        );
        // node missing must not be reported as a launcher problem: both exit 127,
        // and the message names the launcher path in both cases. Verbatim dash
        // output from a host where nvm owned node.
        assert_eq!(
            case(
                "/root/.local/bin/pi-desktop-launcher: 28: exec: node: not found",
                Some(127)
            ),
            (CHECK_NODE, "node_missing")
        );
        assert_eq!(
            case("sh: 1: /home/u/.local/bin/pi-desktop-launcher: not found", Some(127)),
            (CHECK_LAUNCHER, "launcher_missing")
        );
        assert_eq!(
            case(
                "sh: 1: /home/u/.local/bin/pi-desktop-launcher: Permission denied",
                Some(126)
            ),
            (CHECK_LAUNCHER, "launcher_not_executable")
        );
        // An auth failure mentioning the launcher path stays an SSH failure.
        assert_eq!(
            case(
                "Permission denied (publickey). /home/u/.local/bin/pi-desktop-launcher",
                Some(255)
            ),
            (CHECK_SSH, "ssh_auth_failed")
        );
        assert_eq!(case("", Some(255)), (CHECK_SSH, "ssh_failed"));

        // A host enrolled before V2 rejects `--workspace` / `--attach` / the task
        // modes this way. It must not read as an SSH fault: the connection is fine
        // and the fix is a reinstall.
        assert_eq!(
            case("invalid launcher mode", Some(64)),
            (CHECK_LAUNCHER, "launcher_mode_unsupported")
        );
        // Exit 64 also carries this side's argument bugs, which are not the user's
        // to fix and must not offer a reinstall.
        assert_eq!(
            case("task_invalid_arguments", Some(64)),
            (CHECK_SSH, "ssh_failed")
        );
        // The same text without exit 64 is not the launcher's mode dispatch.
        assert_eq!(
            case("invalid launcher mode", Some(255)),
            (CHECK_SSH, "ssh_failed")
        );

        // An empty stderr still describes the exit rather than showing nothing.
        let (_, _, described) = classify_transport_failure(Some(3), "", launcher);
        assert_eq!(described, "ssh exited with 3");
    }

    #[test]
    fn launcher_error_codes_map_onto_their_rows() {
        assert_eq!(
            classify_launcher_failure(Some("workspace_missing")),
            (CHECK_WORKSPACE, "workspace_missing")
        );
        assert_eq!(
            classify_launcher_failure(Some("pi_not_found")),
            (CHECK_PI, "pi_not_found")
        );
        // Unknown codes got past the workspace check, so they are pi-side.
        assert_eq!(
            classify_launcher_failure(Some("something_new")),
            (CHECK_PI, "preflight_failed")
        );
        assert_eq!(classify_launcher_failure(None), (CHECK_PI, "preflight_failed"));
    }

    /// `shell_quote` wraps in single quotes, so a single quote inside the
    /// installer would survive as an escape sequence in the remote script.
    #[test]
    fn installer_script_survives_shell_quoting() {
        assert!(!LAUNCHER_INSTALLER.contains('\''));
        let quoted = shell_quote(LAUNCHER_INSTALLER);
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
        assert!(quoted.contains("cat > \"$temporary\""));
    }

    #[test]
    fn launch_plan_contains_fixed_ssh_policy_and_opaque_payload() {
        let profile = profile();
        let binding = ExecutionBinding::Ssh {
            profile_id: "p1".into(),
            profile_revision: 2,
            host_alias: "prod".into(),
            remote_cwd: profile.remote_cwd.clone().unwrap(),
            launcher_protocol_version: 1,
            remote_task_id: None,
        };
        let spec = ssh_launch_spec(&profile, &binding, Some("/remote/session path")).unwrap();
        let args = spec
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.contains(&"-T".into()));
        assert!(args.contains(&"BatchMode=yes".into()));
        assert!(args.contains(&"StrictHostKeyChecking=yes".into()));
        assert!(args.iter().all(|arg| !arg.contains("/remote/session path")));
    }

    /// The capability query must be answerable before node is involved: it is
    /// most needed precisely when node is broken, which is when every other mode
    /// fails. So it lives in the `sh` prologue, ahead of PATH recovery.
    #[test]
    fn capability_mode_is_answered_before_node_discovery() {
        let source = LAUNCHER_SOURCE;
        let capability_branch = source
            .find("--capabilities")
            .expect("launcher must handle --capabilities");
        let node_probe = source
            .find("if ! command -v node")
            .expect("launcher must still recover node");
        assert!(
            capability_branch < node_probe,
            "--capabilities must be handled before any node discovery"
        );
        // `exec node` is what every other mode ends at; the reply must precede it.
        let exec_node = source.find("exec node").expect("launcher must exec node");
        assert!(capability_branch < exec_node);
    }

    fn detached_profile() -> RemotePiProfile {
        RemotePiProfile { lifecycle: "detached".into(), ..profile() }
    }

    fn argv(spec: &LaunchSpec) -> Vec<String> {
        spec.args
            .iter()
            .map(|argument| argument.to_string_lossy().to_string())
            .collect()
    }

    fn detached_binding(profile: &RemotePiProfile, task_id: Option<&str>) -> ExecutionBinding {
        ExecutionBinding::Ssh {
            profile_id: profile.id.clone(),
            profile_revision: profile.revision,
            host_alias: profile.ssh_host.clone(),
            remote_cwd: profile.remote_cwd.clone().unwrap(),
            launcher_protocol_version: profile.launcher_protocol_version,
            remote_task_id: task_id.map(str::to_owned),
        }
    }

    /// The same pattern the launcher enforces. Both ends check it: the desktop so a
    /// malformed id never reaches a host, the launcher so it never trusts one.
    #[test]
    fn remote_task_ids_match_the_launcher_pattern() {
        for accepted in ["task-0001", "t0000000", "abcdefgh-0123", &"a".repeat(64)] {
            assert!(validate_remote_task_id(accepted).is_ok(), "{accepted}");
        }
        for rejected in ["short7", "Task-0001", "-leading", "task_0001", "task 0001", &"a".repeat(65)] {
            assert!(validate_remote_task_id(rejected).is_err(), "{rejected}");
        }
    }

    /// The task id is present exactly when the profile is detached. A detached
    /// binding with no id has nothing to attach to, and an attached binding with one
    /// names a task no attached run can reach — both are programming errors, not
    /// states to tolerate.
    #[test]
    fn a_task_id_belongs_to_a_detached_binding_and_only_to_one() {
        let detached = detached_profile();
        assert!(validate_binding(&detached, &detached_binding(&detached, Some("task-0001"))).is_ok());
        assert!(validate_binding(&detached, &detached_binding(&detached, None)).is_err());
        assert!(validate_binding(&detached, &detached_binding(&detached, Some("BAD"))).is_err());

        let attached = profile();
        assert!(validate_binding(&attached, &binding(&attached)).is_ok());
        assert!(validate_binding(&attached, &detached_binding(&attached, Some("task-0001"))).is_err());
    }

    /// Fail closed rather than silently doing the attached thing: `--run` holds the
    /// channel open for pi's stdio, which is the one shape a detached task must not
    /// have.
    #[test]
    fn the_two_lifecycles_cannot_borrow_each_other_s_launch_path() {
        let detached = detached_profile();
        let attached = profile();
        assert!(ssh_launch_spec(&detached, &detached_binding(&detached, Some("task-0001")), None).is_err());
        assert!(ssh_start_detached_spec(&attached, &binding(&attached), None).is_err());
    }

    #[test]
    fn detached_start_carries_the_task_id_inside_the_payload_not_the_argv() {
        let profile = detached_profile();
        let binding = detached_binding(&profile, Some("task-0001"));
        let spec = ssh_start_detached_spec(&profile, &binding, Some("/remote/session path")).unwrap();
        let args = argv(&spec);
        assert_eq!(args[args.len() - 2], "'--start-detached'");
        // The id travels base64-encoded with the rest of the payload; the argv shows
        // one opaque token, so a remote path can never be read as a shell word.
        let encoded = args.last().cloned().unwrap();
        assert!(!encoded.contains("task-0001"));
        let decoded = STANDARD.decode(encoded.trim_matches('\'')).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(payload["remoteTaskId"], "task-0001");
        assert_eq!(payload["cwd"], profile.remote_cwd.clone().unwrap());
        assert_eq!(payload["resumePath"], "/remote/session path");
        assert!(args.contains(&"ServerAliveInterval=15".to_owned()));
    }

    /// `--status`/`--stop`/`--send` take the id as itself. Encoding an id already
    /// constrained to `[a-z0-9-]` would only hide a malformed one.
    #[test]
    fn task_modes_pass_the_id_unencoded_and_refuse_the_wrong_arity() {
        let profile = detached_profile();
        let status = ssh_task_spec(&profile, RemoteTaskMode::Status, Some("task-0001")).unwrap();
        assert_eq!(argv(&status).last().map(String::as_str), Some("'task-0001'"));
        // --status with no id lists every task; the other two require one.
        assert!(ssh_task_spec(&profile, RemoteTaskMode::Status, None).is_ok());
        assert!(ssh_task_spec(&profile, RemoteTaskMode::Stop, None).is_err());
        assert!(ssh_task_spec(&profile, RemoteTaskMode::Send, None).is_err());
        assert!(ssh_task_spec(&profile, RemoteTaskMode::Reap, Some("task-0001")).is_err());
        assert!(ssh_task_spec(&profile, RemoteTaskMode::Stop, Some("Bad Id")).is_err());
        for mode in [RemoteTaskMode::Status, RemoteTaskMode::Reap] {
            let spec = ssh_task_spec(&profile, mode, None).unwrap();
            assert!(argv(&spec).contains(&"ServerAliveInterval=15".to_owned()), "{mode:?}");
        }
    }

    /// The shipped launcher and this build's capability names must not drift: the
    /// source is embedded with `include_str!`, so the assertion is against the exact
    /// bytes that get installed.
    #[test]
    fn the_embedded_launcher_advertises_and_implements_every_task_mode() {
        assert!(LAUNCHER_SOURCE.contains("detached-tasks-v1"));
        assert!(LAUNCHER_SOURCE.contains("attach-v1"));
        for mode in [
            "--start-detached", "--supervise", "--status", "--stop", "--send", "--reap", "--attach",
        ] {
            assert!(LAUNCHER_SOURCE.contains(mode), "{mode}");
        }
        // --supervise is internal: it must not be advertised as a capability.
        assert!(!LAUNCHER_SOURCE.contains("supervise-v1"));
    }

    /// The binding crosses the IPC boundary as JSON the *frontend* writes, so it has to be
    /// asserted against that JSON verbatim. Every other test here builds
    /// `ExecutionBinding::Ssh { .. }` in Rust, which exercises the struct and not the
    /// contract — and that gap is exactly how `rename_all` came to rename the variants
    /// while the fields stayed snake_case, breaking `chat_session_save` and `pi_start` for
    /// every remote conversation while the suite stayed green.
    #[test]
    fn the_wire_shape_is_what_the_frontend_actually_sends() {
        // Verbatim from ExecutionTargetPicker.tsx, including the field order.
        let attached = r#"{"kind":"ssh","profileId":"remote-18d0a0eaf11dcf48","profileRevision":1,"hostAlias":"yuyun","remoteCwd":"/root/turb-gpt-free-register","launcherProtocolVersion":1}"#;
        let parsed: ExecutionBinding = serde_json::from_str(attached).expect("frontend ssh binding");
        assert_eq!(
            parsed,
            ExecutionBinding::Ssh {
                profile_id: "remote-18d0a0eaf11dcf48".into(),
                profile_revision: 1,
                host_alias: "yuyun".into(),
                remote_cwd: "/root/turb-gpt-free-register".into(),
                launcher_protocol_version: 1,
                remote_task_id: None,
            }
        );

        // A detached profile adds the task id; an explicit `null` must read the same as
        // absent, because `prepareRemoteBinding` writes null to clear one.
        for json in [
            r#"{"kind":"ssh","profileId":"p1","profileRevision":2,"hostAlias":"h","remoteCwd":"/srv","launcherProtocolVersion":1,"remoteTaskId":"t-000100ab"}"#,
            r#"{"kind":"ssh","profileId":"p1","profileRevision":2,"hostAlias":"h","remoteCwd":"/srv","launcherProtocolVersion":1,"remoteTaskId":null}"#,
        ] {
            let value: ExecutionBinding = serde_json::from_str(json).expect(json);
            let ExecutionBinding::Ssh { profile_id, .. } = &value else {
                panic!("expected ssh");
            };
            assert_eq!(profile_id, "p1");
        }

        // Local, as `pi-process.ts` and `local_execution_binding()` both spell it.
        assert_eq!(
            serde_json::from_str::<ExecutionBinding>(r#"{"kind":"local","targetId":"local"}"#)
                .expect("frontend local binding"),
            ExecutionBinding::Local { target_id: "local".into() }
        );

        // And the write direction, because this is what lands in sqlite and what the
        // frontend reads back out of `chat_sessions_list`. Snake_case here would make
        // every persisted remote session load as `undefined` on the TS side.
        let serialized = serde_json::to_string(&ExecutionBinding::Ssh {
            profile_id: "p1".into(),
            profile_revision: 2,
            host_alias: "h".into(),
            remote_cwd: "/srv".into(),
            launcher_protocol_version: 1,
            remote_task_id: None,
        })
        .unwrap();
        assert!(serialized.contains("\"profileId\":\"p1\""), "{serialized}");
        assert!(!serialized.contains("profile_id"), "{serialized}");
        // Absent rather than null, so a reader cannot mistake "no task" for "some task".
        assert!(!serialized.contains("remoteTaskId"), "{serialized}");
        assert_eq!(
            serde_json::from_str::<ExecutionBinding>(&serialized).unwrap(),
            ExecutionBinding::Ssh {
                profile_id: "p1".into(),
                profile_revision: 2,
                host_alias: "h".into(),
                remote_cwd: "/srv".into(),
                launcher_protocol_version: 1,
                remote_task_id: None,
            }
        );
    }

    /// The `--capabilities` reply is a hand-written string in the `sh` preamble, so the
    /// versions it reports can drift from both this build's constants and the node-side
    /// STATUS_VERSION further down the same file. Every drift is silent and dangerous:
    /// a stale `launcherRevision` makes an upgraded host look old and reinstall forever,
    /// and a stale `statusVersion` makes an unsafe overwrite look safe. Asserted against
    /// the exact bytes that get installed.
    #[test]
    fn the_shell_preamble_reports_the_node_side_versions() {
        assert!(
            LAUNCHER_SOURCE.contains(&format!("\"launcherRevision\":{LAUNCHER_REVISION}")),
            "sh preamble does not report launcherRevision {LAUNCHER_REVISION}"
        );
        assert!(
            LAUNCHER_SOURCE.contains(&format!("\"statusVersion\":{LAUNCHER_STATUS_VERSION}")),
            "sh preamble does not report statusVersion {LAUNCHER_STATUS_VERSION}"
        );
        // The node half is the authority on what the state files actually contain, so
        // the preamble is only correct if it agrees with this line.
        assert!(
            LAUNCHER_SOURCE.contains(&format!("const STATUS_VERSION = {LAUNCHER_STATUS_VERSION};")),
            "node STATUS_VERSION is not {LAUNCHER_STATUS_VERSION}"
        );
    }

    /// The gate, as a table. Written out because every wrong cell has a concrete cost:
    /// a spurious upgrade strands tasks, a spurious downgrade breaks another desktop,
    /// and a spurious "already current" leaves a dead mode dead.
    #[test]
    fn the_upgrade_gate_only_replaces_a_launcher_when_that_is_safe() {
        let current = LAUNCHER_REVISION;
        let status = LAUNCHER_STATUS_VERSION;
        let newer = current + 1;
        let other_status = status + 1;

        // Same revision: never touch the host, whatever else is true.
        assert_eq!(
            decide_upgrade(true, current, status, true, None),
            UpgradeDecision::AlreadyCurrent
        );
        assert_eq!(
            decide_upgrade(true, current, status, true, Some(9)),
            UpgradeDecision::AlreadyCurrent
        );

        // The case this feature exists for: a host enrolled before revisions, which
        // reports 0. It must upgrade — skipping it would leave every pre-V2 host in the
        // fleet running dead modes forever, which is the whole bug. Its capability list
        // has no task support, so nothing can be stranded and no count is needed.
        assert_eq!(
            decide_upgrade(true, 0, 0, false, None),
            UpgradeDecision::Upgrade
        );
        // Same host, but too old to answer the query at all (exit 64). Still ours, still
        // upgraded, and notably *not* read as current just because both revisions are 0.
        assert_eq!(
            decide_upgrade(false, 0, 0, false, None),
            UpgradeDecision::Upgrade
        );

        // A host some newer desktop already upgraded. Overwriting would take working
        // features away from that desktop, so this is never automatic.
        assert_eq!(
            decide_upgrade(true, newer, status, true, Some(0)),
            UpgradeDecision::RemoteIsNewer
        );
        // Newer wins over everything, including an unreadable task list.
        assert_eq!(
            decide_upgrade(true, newer, other_status, true, None),
            UpgradeDecision::RemoteIsNewer
        );

        // The rest only becomes reachable once revisions advance past 1, so it is
        // asserted against a hypothetical future pair rather than `current - 1`.
        // Behind with the same state format is safe even with tasks running, because
        // this build reads exactly the status.json they already wrote.
        assert_eq!(
            decide_upgrade(true, current, status, true, Some(3)),
            UpgradeDecision::AlreadyCurrent,
            "sanity: current means current"
        );

        // Behind, state format would change, host supports tasks. Empty is fine;
        // anything else waits — including a count that could not be established,
        // because one unparseable status file aborts the whole listing, so "cannot
        // count" is evidence of the problem rather than of an idle host.
        for (live, want) in [
            (Some(0), UpgradeDecision::Upgrade),
            (Some(1), UpgradeDecision::BlockedByLiveTasks),
            (None, UpgradeDecision::BlockedByLiveTasks),
        ] {
            assert_eq!(
                decide_upgrade(true, 0, other_status, true, live),
                want,
                "live={live:?}"
            );
        }
        // Same, but the host cannot have tasks at all: never blocked on a count it
        // could never answer.
        assert_eq!(
            decide_upgrade(true, 0, other_status, false, None),
            UpgradeDecision::Upgrade
        );
    }

    /// Attach is the long-lived channel, so it has to carry the same liveness probe as
    /// `--run`: without it a partition leaves the local ssh blocked on a socket that
    /// will never answer, and the UI stays "running" with no exit event.
    #[test]
    fn attach_carries_the_cursor_in_its_payload_and_the_liveness_probe_in_its_argv() {
        let profile = detached_profile();
        let binding = detached_binding(&profile, Some("task-0001"));
        let spec = ssh_attach_spec(&profile, &binding, Some(41), true).unwrap();
        let args = argv(&spec);
        assert_eq!(args[args.len() - 2], "'--attach'");
        assert!(args.contains(&"ServerAliveInterval=15".to_owned()));
        assert!(args.contains(&"ServerAliveCountMax=3".to_owned()));
        let decoded = STANDARD.decode(args.last().unwrap().trim_matches('\'')).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(payload["remoteTaskId"], "task-0001");
        assert_eq!(payload["after"], 41);
        assert_eq!(payload["follow"], true);
        // Addresses a task rather than describing a launch, so none of the run
        // payload's fields belong here.
        for absent in ["cwd", "piExecutable", "resumePath"] {
            assert!(payload.get(absent).is_none(), "{absent}");
        }
        // A fresh attach starts from the oldest retained record.
        let fresh = ssh_attach_spec(&profile, &binding, None, false).unwrap();
        let fresh_payload: serde_json::Value = serde_json::from_slice(
            &STANDARD.decode(argv(&fresh).last().unwrap().trim_matches('\'')).unwrap(),
        )
        .unwrap();
        assert_eq!(fresh_payload["after"], serde_json::Value::Null);
        assert_eq!(fresh_payload["follow"], false);
    }

    /// Workspace browsing is profile-scoped and lifecycle-agnostic: an attached
    /// profile browses the same host the same way. Only the operation, the path and
    /// the encoding are constrained.
    #[test]
    fn workspace_requests_are_constrained_and_travel_base64_encoded() {
        let profile = profile();
        let spec = ssh_workspace_spec(&profile, "read", "/srv/project with spaces/a.txt", Some("base64"), None, None)
                .unwrap();
        let args = argv(&spec);
        assert_eq!(args[args.len() - 2], "--workspace");
        assert!(args.contains(&"ServerAliveInterval=15".to_owned()));
        // One opaque token: a remote path with a space or a quote can never be read
        // as a shell word.
        let encoded = args.last().cloned().unwrap();
        assert!(!encoded.contains("a.txt"));
        let payload: serde_json::Value =
            serde_json::from_slice(&STANDARD.decode(encoded.trim_matches('\'')).unwrap()).unwrap();
        assert_eq!(payload["operation"], "read");
        assert_eq!(payload["path"], "/srv/project with spaces/a.txt");
        assert_eq!(payload["encoding"], "base64");
        assert_eq!(payload["protocolVersion"], 1);

        // Omitted encoding stays omitted rather than defaulting on the wire: the
        // launcher owns that default, so only one side gets to choose it.
        let listing = ssh_workspace_spec(&profile, "list", "/srv", None, None, None).unwrap();
        let listed: serde_json::Value = serde_json::from_slice(
            &STANDARD.decode(argv(&listing).last().unwrap().trim_matches('\'')).unwrap(),
        )
        .unwrap();
        assert!(listed.get("encoding").is_none());

        for (operation, path, encoding) in [
            ("delete", "/srv", None),
            ("list", "relative", None),
            ("read", "/srv/a.txt", Some("hex")),
            ("stat", "/srv/evil", None),
        ] {
            assert!(
                ssh_workspace_spec(&profile, operation, path, encoding, None, None).is_err(),
                "{operation} {path}"
            );
        }
    }
    /// The three states of `expectedHash` are distinct and the launcher acts
    /// differently on each, so the wire has to preserve all three: absent means the
    /// caller has not decided (refused), explicit null asserts the path is free, and a
    /// token is If-Match.
    #[test]
    fn a_write_preserves_all_three_expected_hash_states() {
        let profile = profile();
        let decode = |spec: &LaunchSpec| -> serde_json::Value {
            serde_json::from_slice(
                &STANDARD.decode(argv(spec).last().unwrap().trim_matches('\'')).unwrap(),
            )
            .unwrap()
        };
        let token = format!("sha256-{}", "a".repeat(64));

        let absent = decode(&ssh_workspace_spec(&profile, "write", "/srv/a.txt", Some("utf8"), None, None).unwrap());
        assert!(absent.get("expectedHash").is_none());

        let free = decode(&ssh_workspace_spec(&profile, "write", "/srv/a.txt", Some("utf8"), None, Some(None)).unwrap());
        assert_eq!(free["expectedHash"], serde_json::Value::Null);

        let matched = decode(
            &ssh_workspace_spec(&profile, "write", "/srv/a.txt", Some("utf8"), None, Some(Some(&token))).unwrap(),
        );
        assert_eq!(matched["expectedHash"], token);
        assert_eq!(matched["operation"], "write");
    }

    /// A malformed hash is a caller bug, and letting one through would surface as a
    /// mysterious mismatch from the far end instead of an error at the boundary.
    #[test]
    fn a_malformed_hash_or_a_stray_destination_is_refused_locally() {
        let profile = profile();
        for hash in ["deadbeef", "sha256-", &format!("sha256-{}", "A".repeat(64)), &format!("sha256-{}", "a".repeat(63))] {
            assert!(
                ssh_workspace_spec(&profile, "write", "/srv/a.txt", None, None, Some(Some(hash))).is_err(),
                "{hash}"
            );
        }
        // `to` belongs to rename and to nothing else.
        assert!(ssh_workspace_spec(&profile, "rename", "/srv/a.txt", None, None, None).is_err());
        assert!(ssh_workspace_spec(&profile, "write", "/srv/a.txt", None, Some("/srv/b.txt"), None).is_err());
        assert!(ssh_workspace_spec(&profile, "rename", "/srv/a.txt", None, Some("relative"), None).is_err());
        let renamed = ssh_workspace_spec(&profile, "rename", "/srv/a.txt", None, Some("/srv/b.txt"), None).unwrap();
        let payload: serde_json::Value = serde_json::from_slice(
            &STANDARD.decode(argv(&renamed).last().unwrap().trim_matches('\'')).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["to"], "/srv/b.txt");
    }
    #[test]
    fn only_a_detached_binding_can_be_attached() {        let attached = profile();
        assert!(ssh_attach_spec(&attached, &binding(&attached), None, true).is_err());
        let detached = detached_profile();
        assert!(ssh_attach_spec(&detached, &detached_binding(&detached, None), None, true).is_err());
        assert!(ssh_attach_spec(
            &detached,
            &ExecutionBinding::Local { target_id: "local".into() },
            None,
            true
        )
        .is_err());
    }

    #[test]
    fn capability_spec_carries_no_payload_argument() {
        let spec = ssh_capabilities_spec("prod", "/opt/pi-desktop-launcher");
        let args = spec
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(args.last().map(String::as_str), Some("--capabilities"));
        assert!(args.contains(&"BatchMode=yes".into()));
        assert!(args.contains(&"ServerAliveInterval=15".into()));
        // The launcher rejects --capabilities with any extra argument, so sending
        // one would turn every probe into exit 64 and look like an old launcher.
        assert_eq!(
            args.iter().filter(|arg| arg.starts_with("--capabilities")).count(),
            1
        );
    }

    /// The reply is parsed leniently on purpose: a newer launcher adding fields
    /// must not be able to break an older desktop.
    #[test]
    fn capability_reply_ignores_unknown_fields() {
        let reply: CapabilitiesReply = serde_json::from_str(
            r#"{"launcherProtocolVersion":1,"capabilities":["run-v1"],"somethingNew":{"a":1}}"#,
        )
        .expect("unknown fields must be ignored, not rejected");
        assert_eq!(reply.launcher_protocol_version, 1);
        assert_eq!(reply.capabilities, vec!["run-v1".to_owned()]);
    }

    /// A run channel that cannot notice a partition is the root cause of
    /// "SSH disconnected; remote process status is unknown": without a liveness
    /// probe the local `ssh` never exits, so no code path gets to run at all.
    #[test]
    fn every_ssh_invocation_carries_a_liveness_probe() {
        let profile = profile();
        let binding = ExecutionBinding::Ssh {
            profile_id: "p1".into(),
            profile_revision: 2,
            host_alias: "prod".into(),
            remote_cwd: profile.remote_cwd.clone().unwrap(),
            launcher_protocol_version: 1,
            remote_task_id: None,
        };
        let specs = [
            ssh_launch_spec(&profile, &binding, None).unwrap(),
            ssh_provider_sync_spec(&profile),
        ];
        for spec in specs {
            let args = spec
                .args
                .iter()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>();
            assert!(args.contains(&"ServerAliveInterval=15".into()));
            assert!(args.contains(&"ServerAliveCountMax=3".into()));
        }
    }
}
