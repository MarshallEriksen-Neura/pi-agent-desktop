//! Remote update check against the release git repository.
//!
//! Updates ship as semver tags (`v1.2.3`) on UPDATE_REPO_URL, queried with
//! `git ls-remote --tags` — nothing is cloned or downloaded during a check.
//! If the constant is ever emptied both commands degrade gracefully:
//! `update_check` reports `configured: false`, `update_apply` refuses to run.

use serde::Serialize;
use std::process::{Command, Stdio};

/// Release repository queried for version tags.
const UPDATE_REPO_URL: &str = "https://github.com/MarshallEriksen-Neura/pi-agent-desktop.git";

/// The pi CLI's release repository — pi ships as semver tags on pi-mono, not
/// on npm (the npm packages lag behind). `pi update` is the installer.
const PI_CLI_REPO_URL: &str = "https://github.com/badlogic/pi-mono.git";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    configured: bool,
    repo_url: String,
    current_version: String,
    latest_version: Option<String>,
    latest_commit: Option<String>,
    update_available: bool,
}

/// "v1.2.3-beta" → [1, 2, 3]; None when the tag isn't version-shaped.
fn semver(tag: &str) -> Option<Vec<u64>> {
    let core = tag.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let parts = core
        .split('.')
        .map(|p| p.parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    (!parts.is_empty()).then_some(parts)
}

/// Component-wise compare with zero padding ([1,2] < [1,2,1]).
fn semver_gt(a: &[u64], b: &[u64]) -> bool {
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// `git ls-remote --tags <repo>` → (highest semver tag, its commit sha).
fn latest_remote_tag(repo: &str) -> Result<Option<(String, String)>, String> {
    let mut cmd = Command::new("git");
    cmd.args(["ls-remote", "--tags", repo])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }

    // Lines are "<sha>\trefs/tags/<name>"; annotated tags repeat as
    // "<name>^{}" pointing at the peeled commit — prefer that sha.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut best: Option<(Vec<u64>, String, String)> = None;
    for line in stdout.lines() {
        let Some((sha, r)) = line.split_once('\t') else {
            continue;
        };
        let Some(tag) = r.strip_prefix("refs/tags/") else {
            continue;
        };
        let (name, peeled) = match tag.strip_suffix("^{}") {
            Some(n) => (n, true),
            None => (tag, false),
        };
        let Some(v) = semver(name) else { continue };
        let replace = match &best {
            None => true,
            Some((bv, bn, _)) => semver_gt(&v, bv) || (peeled && bn == name),
        };
        if replace {
            best = Some((v, name.to_string(), sha.to_string()));
        }
    }
    Ok(best.map(|(_, name, sha)| (name, sha)))
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    if UPDATE_REPO_URL.is_empty() {
        return Ok(UpdateInfo {
            configured: false,
            repo_url: String::new(),
            current_version: current,
            latest_version: None,
            latest_commit: None,
            update_available: false,
        });
    }

    let latest = tauri::async_runtime::spawn_blocking(|| latest_remote_tag(UPDATE_REPO_URL))
        .await
        .map_err(|e| e.to_string())??;

    let cur = semver(&current).unwrap_or_default();
    let (latest_version, latest_commit, update_available) = match latest {
        Some((tag, sha)) => {
            let newer = semver(&tag).map(|v| semver_gt(&v, &cur)).unwrap_or(false);
            let short = sha[..sha.len().min(7)].to_string();
            (Some(tag), Some(short), newer)
        }
        None => (None, None, false),
    };

    Ok(UpdateInfo {
        configured: true,
        repo_url: UPDATE_REPO_URL.to_string(),
        current_version: current,
        latest_version,
        latest_commit,
        update_available,
    })
}

/* ── pi CLI update check ─────────────────────────────────────────────────
   The desktop app is a GUI over the `pi` CLI; the CLI updates itself with
   `pi update` (invoked from the frontend through the existing `pi_cli`
   command). This check only answers "is a newer pi available?". */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PiCliUpdateInfo {
    /// `pi --version` output; None when the binary isn't on PATH.
    installed: Option<String>,
    latest: Option<String>,
    update_available: bool,
}

/// `pi --version` → "0.81.1"; None when pi is missing or errors.
fn pi_installed_version() -> Option<String> {
    let mut cmd = Command::new("pi");
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[tauri::command]
pub async fn pi_cli_update_check() -> Result<PiCliUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let installed = pi_installed_version();
        // No pi → nothing to compare; skip the remote query entirely.
        if installed.is_none() {
            return Ok(PiCliUpdateInfo {
                installed: None,
                latest: None,
                update_available: false,
            });
        }
        let latest = latest_remote_tag(PI_CLI_REPO_URL)?.map(|(tag, _)| tag);
        let update_available = match (
            installed.as_deref().and_then(semver),
            latest.as_deref().and_then(semver),
        ) {
            (Some(cur), Some(new)) => semver_gt(&new, &cur),
            _ => false,
        };
        Ok(PiCliUpdateInfo {
            installed,
            latest,
            update_available,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One-tap update. The download/install pipeline lands together with the
/// release repository; until then this refuses so the UI can explain why.
#[tauri::command]
pub async fn update_apply() -> Result<(), String> {
    if UPDATE_REPO_URL.is_empty() {
        return Err("update source not configured".into());
    }
    // TODO: download the tagged release, swap binaries, relaunch.
    Err("auto-update pipeline is not wired up yet".into())
}
