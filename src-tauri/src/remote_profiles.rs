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
const PREFLIGHT_OUTPUT_MAX_BYTES: usize = 64 * 1024;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PROFILE_NAME_BYTES: usize = 256;
const MAX_HOST_ALIAS_BYTES: usize = 256;
const MAX_REMOTE_PATH_BYTES: usize = 4096;
const MAX_PROFILE_ID_BYTES: usize = 128;
const MAX_SAFE_JS_INTEGER: u64 = 9_007_199_254_740_991;
static PROFILE_STORE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePiProfile {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub ssh_host: String,
    pub remote_cwd: String,
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
    pub remote_cwd: String,
    pub pi_executable: Option<String>,
    pub launcher_path: Option<String>,
    pub launcher_protocol_version: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPayload<'a> {
    protocol_version: u32,
    cwd: &'a str,
    pi_executable: &'a str,
    resume_path: Option<&'a str>,
}

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
    cwd: &str,
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
    validate_remote_path(cwd, "remote cwd")?;
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

fn validate_profile(profile: &RemotePiProfile) -> Result<(), String> {
    validate_profile_id(&profile.id)?;
    if profile.revision == 0
        || profile.revision > MAX_SAFE_JS_INTEGER
        || profile.lifecycle != "attached"
    {
        return Err(format!(
            "remote profile `{}` has invalid metadata",
            profile.id
        ));
    }
    validate_profile_fields(
        &profile.name,
        &profile.ssh_host,
        &profile.remote_cwd,
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
    validate_profile_fields(
        &profile.name,
        &profile.ssh_host,
        &profile.remote_cwd,
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
    let saved = RemotePiProfile {
        id,
        revision,
        name: profile.name.trim().to_owned(),
        ssh_host: profile.ssh_host,
        remote_cwd: profile.remote_cwd,
        pi_executable: pi_executable.map(str::to_owned),
        launcher_path: launcher.to_owned(),
        launcher_protocol_version: protocol_version,
        lifecycle: "attached".into(),
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
        || remote_cwd != &profile.remote_cwd
        || *launcher_protocol_version != profile.launcher_protocol_version
    {
        return Err("remote execution binding does not match the stored profile".into());
    }
    Ok(())
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
    let encoded = encode_launcher_payload(
        remote_cwd,
        profile.pi_executable.as_deref().unwrap_or("pi"),
        *launcher_protocol_version,
        resume_path,
    )?;
    Ok(ssh_spec_for(
        &profile.ssh_host,
        &profile.launcher_path,
        "--run",
        &encoded,
    ))
}

fn encode_launcher_payload(
    remote_cwd: &str,
    pi_executable: &str,
    protocol_version: u32,
    resume_path: Option<&str>,
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
    let payload = LauncherPayload {
        protocol_version,
        cwd: remote_cwd,
        pi_executable,
        resume_path,
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
        "RequestTTY=no",
    ]
}

/// Quote one remote-shell argument. The local process still uses argv; this is
/// needed because OpenSSH joins command arguments before sending them remotely.
fn shell_quote(value: &str) -> String {
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
        &profile.remote_cwd,
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
    validate_host_alias(&profile.ssh_host)?;
    validate_remote_path(&profile.remote_cwd, "remote cwd")?;
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
        &profile.remote_cwd,
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

fn check_readiness(
    profile_id: Option<String>,
    host: &str,
    remote_cwd: &str,
    launcher_path: &str,
    pi_executable: &str,
    protocol_version: u32,
) -> RemoteReadinessReport {
    let mut report = RemoteReadinessReport {
        ok: false,
        profile_id,
        host: host.to_owned(),
        remote_cwd: remote_cwd.to_owned(),
        launcher_path: launcher_path.to_owned(),
        pi_version: None,
        checks: Vec::new(),
    };

    let encoded = match encode_launcher_payload(remote_cwd, pi_executable, protocol_version, None) {
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
    let output = match run_bounded_command(&spec, PREFLIGHT_TIMEOUT, None) {
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
        report.checks.push(RemoteReadinessCheck::ok(
            CHECK_WORKSPACE,
            Some(remote_cwd.to_owned()),
        ));
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

/// Copies the embedded launcher to the remote host over the same SSH policy the
/// runtime uses, then reports the absolute path it landed on. Passing
/// `launcher_path: None` (or the `-` sentinel) resolves
/// `$HOME/.local/bin/pi-desktop-launcher`, which needs no sudo.
#[tauri::command]
pub fn remote_profile_install_launcher(
    host: String,
    launcher_path: Option<String>,
) -> Result<LauncherInstallResult, String> {
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

    let output = run_bounded_command(&spec, INSTALL_TIMEOUT, Some(LAUNCHER_SOURCE))?;
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
            .take((PREFLIGHT_OUTPUT_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take((PREFLIGHT_OUTPUT_MAX_BYTES + 1) as u64)
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
        classify_launcher_failure, classify_transport_failure, shell_quote, ssh_launch_spec,
        validate_binding, validate_profile_fields, validate_profile_id, ExecutionBinding,
        RemotePiProfile, CHECK_LAUNCHER, CHECK_NODE, CHECK_PI, CHECK_SSH, CHECK_WORKSPACE,
        LAUNCHER_INSTALLER,
    };

    fn profile() -> RemotePiProfile {
        RemotePiProfile {
            id: "p1".into(),
            revision: 2,
            name: "Server".into(),
            ssh_host: "prod".into(),
            remote_cwd: "/srv/project with spaces".into(),
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
            remote_cwd: profile.remote_cwd.clone(),
            launcher_protocol_version: profile.launcher_protocol_version,
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
            "/srv/project",
            Some("pi"),
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_ok());
        assert!(validate_profile_fields(
            "Server",
            "-oProxyCommand=bad",
            "/srv/project",
            None,
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_err());
        assert!(validate_profile_fields(
            "Server",
            "prod",
            "relative/project",
            None,
            "/usr/local/bin/pi-desktop-launcher",
            1,
        )
        .is_err());
        assert!(validate_profile_fields(
            "Server",
            "prod",
            "/srv/project",
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
            remote_cwd: profile.remote_cwd.clone(),
            launcher_protocol_version: profile.launcher_protocol_version,
        };
        assert!(validate_binding(&profile, &stale).is_err());

        let moved = ExecutionBinding::Ssh {
            profile_id: profile.id.clone(),
            profile_revision: profile.revision,
            host_alias: profile.ssh_host.clone(),
            remote_cwd: "/srv/other".into(),
            launcher_protocol_version: profile.launcher_protocol_version,
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
            remote_cwd: profile.remote_cwd.clone(),
            launcher_protocol_version: 1,
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
}
