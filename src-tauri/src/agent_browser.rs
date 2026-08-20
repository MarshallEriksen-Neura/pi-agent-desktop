//! Detect and install the upstream `agent-browser` CLI used by pi's
//! `agent_browser` tool (the `pi-agent-browser-native` extension wrapper).
//!
//! The wrapper spawns `agent-browser` off PATH and parses its `--json`
//! envelope. When the binary is missing the wrapper classifies the failure as
//! a misleading `parse-failure` (on Windows the PowerShell launch error does
//! not match its missing-binary heuristics). The desktop app therefore owns
//! the pre-flight check and offers a one-click `npm install -g agent-browser`,
//! which also produces the `agent-browser.cmd` shim the Windows wrapper
//! expects. `EXPECTED_VERSION` mirrors the wrapper's capability baseline.

use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `pi-agent-browser-native` capability baseline (doctor gate).
const EXPECTED_VERSION: &str = "0.33.0";
/// Upper bound for `npm install -g agent-browser` (downloads the binary).
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
/// Cap captured install logs so a chatty npm run cannot balloon memory.
const MAX_LOG_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub expected: String,
    /// True only when the installed version is *older* than `EXPECTED_VERSION`.
    /// A newer CLI satisfies the capability baseline, so it must not warn.
    pub outdated: bool,
    pub error: Option<String>,
}

/// Compare dotted numeric versions (`0.34.0` vs `0.33.0`).
///
/// Non-numeric segments (pre-release suffixes like `1.0.0-beta.2`) compare as
/// their leading number, which is enough for a "is this older than the
/// baseline" gate.
fn is_older(version: &str, baseline: &str) -> bool {
    let segments = |value: &str| -> Vec<u64> {
        value
            .split(['.', '-', '+'])
            .map(|part| {
                part.chars()
                    .take_while(char::is_ascii_digit)
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let left = segments(version);
    let right = segments(baseline);
    let width = left.len().max(right.len());
    for index in 0..width {
        let a = left.get(index).copied().unwrap_or(0);
        let b = right.get(index).copied().unwrap_or(0);
        if a != b {
            return a < b;
        }
    }
    false
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserInstallResult {
    pub ok: bool,
    pub log: String,
    pub status: AgentBrowserStatus,
}

/// Strip a `agent-browser 0.33.0` style prefix and take the first token.
fn parse_version(text: &str) -> Option<String> {
    text.trim()
        .trim_start_matches("agent-browser")
        .trim()
        .split_whitespace()
        .next()
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
}

fn check_sync() -> AgentBrowserStatus {
    let Some(binary) = crate::pi_command::resolve_executable("agent-browser") else {
        return AgentBrowserStatus {
            installed: false,
            version: None,
            expected: EXPECTED_VERSION.to_owned(),
            outdated: false,
            error: None,
        };
    };
    match Command::new(&binary).arg("--version").output() {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            let version = parse_version(&text);
            let outdated = version
                .as_deref()
                .map(|value| is_older(value, EXPECTED_VERSION))
                .unwrap_or(false);
            AgentBrowserStatus {
                installed: output.status.success(),
                version,
                expected: EXPECTED_VERSION.to_owned(),
                outdated,
                error: None,
            }
        }
        Err(error) => AgentBrowserStatus {
            installed: false,
            version: None,
            expected: EXPECTED_VERSION.to_owned(),
            outdated: false,
            error: Some(error.to_string()),
        },
    }
}

fn drain(mut handle: impl Read, log: &mut String) {
    let mut buffer = [0u8; 8192];
    loop {
        match handle.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if log.len() < MAX_LOG_BYTES {
                    log.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    if log.len() > MAX_LOG_BYTES {
                        log.truncate(MAX_LOG_BYTES);
                        log.push_str("\n[output truncated]");
                    }
                }
            }
        }
    }
}

fn run_install() -> AgentBrowserInstallResult {
    let mut log = String::new();
    let Some(npm) = crate::pi_command::resolve_executable("npm") else {
        log.push_str("npm was not found on PATH.\n");
        return AgentBrowserInstallResult {
            ok: false,
            log,
            status: check_sync(),
        };
    };

    let mut child = match Command::new(&npm)
        .arg("install")
        .arg("-g")
        .arg("agent-browser")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log.push_str(&format!("failed to spawn npm: {error}\n"));
            return AgentBrowserInstallResult {
                ok: false,
                log,
                status: check_sync(),
            };
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let deadline = Instant::now() + INSTALL_TIMEOUT;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    log.push_str(&format!(
                        "npm install timed out after {INSTALL_TIMEOUT:?}\n"
                    ));
                    break -1;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(error) => {
                log.push_str(&format!("npm install failed: {error}\n"));
                break -1;
            }
        }
    };
    if let Some(handle) = stdout {
        drain(handle, &mut log);
    }
    if let Some(handle) = stderr {
        drain(handle, &mut log);
    }

    let status = check_sync();
    AgentBrowserInstallResult {
        ok: exit_code == 0 && status.installed,
        log,
        status,
    }
}

#[tauri::command]
pub fn agent_browser_check() -> AgentBrowserStatus {
    check_sync()
}

#[tauri::command]
pub async fn agent_browser_install() -> Result<AgentBrowserInstallResult, String> {
    tauri::async_runtime::spawn_blocking(run_install)
        .await
        .map_err(|error| format!("install task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{is_older, parse_version};

    #[test]
    fn flags_only_versions_below_the_baseline() {
        assert!(is_older("0.32.9", "0.33.0"));
        assert!(is_older("0.9.0", "0.33.0"));
        // Equal or newer satisfies the baseline — this was the false positive.
        assert!(!is_older("0.33.0", "0.33.0"));
        assert!(!is_older("0.34.0", "0.33.0"));
        assert!(!is_older("1.0.0", "0.33.0"));
    }

    #[test]
    fn tolerates_short_and_prerelease_versions() {
        assert!(is_older("0.33", "0.33.1"));
        assert!(!is_older("0.33.0-beta.1", "0.33.0"));
        assert!(!is_older("garbage", "0.0.0"));
    }

    #[test]
    fn parses_bare_version() {
        assert_eq!(parse_version("0.33.0").as_deref(), Some("0.33.0"));
    }

    #[test]
    fn parses_prefixed_version() {
        assert_eq!(parse_version("agent-browser 0.33.0").as_deref(), Some("0.33.0"));
    }

    #[test]
    fn ignores_non_version_output() {
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("  \n"), None);
        assert_eq!(parse_version("command not found"), Some("command".to_owned()));
    }
}
