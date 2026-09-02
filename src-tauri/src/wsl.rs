//! Compatibility support for retiring the legacy WSL shell bridge.
//!
//! Older desktop releases replaced Pi's `shellPath` with this executable and
//! persisted WSL metadata in `desktop.json`. New releases execute only on the
//! Windows host or over SSH. We therefore restore the saved native shell settings
//! before Pi starts, while keeping the old `<desktop.exe> -c <command>` entry point
//! for one upgrade window so an already-running legacy Pi process does not break.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

static LEGACY_WSL_MIGRATION: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    #[default]
    Native,
    Wsl,
}

/// Legacy app-owned runtime config. Keep this shape readable for the migration
/// window; no current frontend command can create or modify it.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeConfig {
    pub mode: RuntimeMode,
    pub distro: String,
    pub native_shell_path: Option<String>,
    pub native_shell_command_prefix: Option<String>,
    pub native_shell_saved: bool,
}

#[derive(Debug, PartialEq)]
struct WslContext {
    distro: String,
    cwd: Option<String>,
}

fn wsl_executable() -> PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var("SystemRoot")
            .or_else(|_| std::env::var("WINDIR"))
            .unwrap_or_else(|_| r"C:\Windows".to_string());
        return PathBuf::from(base).join("System32").join("wsl.exe");
    }

    #[cfg(not(windows))]
    PathBuf::from("wsl.exe")
}

/// Interpret a cwd written by the removed bridge. This is intentionally private
/// compatibility code, not a current execution-target implementation.
fn resolve_context(config: &RuntimeConfig, cwd: Option<&str>) -> Result<WslContext, String> {
    let mut distro = config.distro.trim().to_string();
    let Some(raw_cwd) = cwd.filter(|value| !value.trim().is_empty()) else {
        return Ok(WslContext { distro, cwd: None });
    };

    let normalized = raw_cwd.replace('\\', "/");
    let unc_rest = normalized
        .strip_prefix("//wsl.localhost/")
        .or_else(|| normalized.strip_prefix("//wsl$/"));

    if let Some(rest) = unc_rest {
        let (path_distro, path) = rest
            .split_once('/')
            .ok_or_else(|| format!("WSL project path has no directory component: {raw_cwd}"))?;
        if !distro.is_empty() && !distro.eq_ignore_ascii_case(path_distro) {
            return Err(format!(
                "project belongs to WSL distro `{path_distro}`, but legacy runtime uses `{distro}`"
            ));
        }
        if distro.is_empty() {
            distro = path_distro.to_string();
        }
        return Ok(WslContext {
            distro,
            cwd: Some(format!("/{path}")),
        });
    }

    Ok(WslContext {
        distro,
        cwd: Some(normalized),
    })
}

fn append_context_args(cmd: &mut Command, context: &WslContext) {
    cmd.env("WSL_UTF8", "1");
    if !context.distro.is_empty() {
        cmd.args(["-d", &context.distro]);
    }
    if let Some(cwd) = &context.cwd {
        cmd.args(["--cd", cwd]);
    }
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

fn actionable_wsl_diagnostic(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !(lower.contains("localhost")
                && lower.contains("nat")
                && (lower.contains("proxy") || line.contains("代理")))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn shell_bridge_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|error| format!("failed to resolve desktop executable: {error}"))
}

fn is_legacy_wsl_override(path: Option<&str>, prefix: Option<&serde_json::Value>) -> bool {
    let path_is_wsl = path
        .map(|value| value.replace('\\', "/").to_ascii_lowercase())
        .is_some_and(|value| value.ends_with("/windows/system32/wsl.exe"));
    let prefix_is_legacy = prefix
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| {
            let values: Vec<_> = items.iter().filter_map(serde_json::Value::as_str).collect();
            matches!(values.as_slice(), ["--", "bash"] | ["-d", _, "--", "bash"])
        });
    path_is_wsl && prefix_is_legacy
}

fn is_managed_shell_override(
    path: Option<&str>,
    prefix: Option<&serde_json::Value>,
    bridge_path: &str,
) -> bool {
    path == Some(bridge_path) || is_legacy_wsl_override(path, prefix)
}

fn update_settings<R>(
    path: &std::path::Path,
    update: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<R, String>,
) -> Result<R, String> {
    pi_backend_core::projects::DurableJsonStore::new(path)
        .update_locked(|current| {
            let mut settings = current.unwrap_or_else(|| serde_json::json!({}));
            let object = settings.as_object_mut().ok_or_else(|| {
                pi_backend_core::projects::StateStoreError::UpdateRejected(format!(
                    "{} root must be a JSON object",
                    path.display()
                ))
            })?;
            let result = update(object)
                .map_err(pi_backend_core::projects::StateStoreError::UpdateRejected)?;
            Ok((settings, result))
        })
        .map_err(|error| format!("cannot update {}: {error}", path.display()))
}

fn restore_setting(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    value: &Option<serde_json::Value>,
) {
    match value {
        Some(value) => {
            object.insert(key.into(), value.clone());
        }
        None => {
            object.remove(key);
        }
    }
}

fn restore_global_shell_settings(
    object: &mut serde_json::Map<String, serde_json::Value>,
    config: &RuntimeConfig,
    bridge_path: &str,
) {
    let current_path = object.get("shellPath").and_then(serde_json::Value::as_str);
    let current_prefix = object.get("shellCommandPrefix");
    if !is_managed_shell_override(current_path, current_prefix, bridge_path) {
        return;
    }

    if config.native_shell_saved {
        restore_setting(
            object,
            "shellPath",
            &config
                .native_shell_path
                .as_ref()
                .map(|value| serde_json::Value::String(value.clone())),
        );
        restore_setting(
            object,
            "shellCommandPrefix",
            &config
                .native_shell_command_prefix
                .as_ref()
                .map(|value| serde_json::Value::String(value.clone())),
        );
    } else {
        object.remove("shellPath");
        object.remove("shellCommandPrefix");
    }
}

fn restore_project_shell_settings(
    object: &mut serde_json::Map<String, serde_json::Value>,
    backup: &crate::projects::ShellSettingsBackup,
    bridge_path: &str,
) {
    let current_path = object.get("shellPath").and_then(serde_json::Value::as_str);
    if current_path != Some(bridge_path) {
        return;
    }
    restore_setting(object, "shellPath", &backup.shell_path);
    restore_setting(object, "shellCommandPrefix", &backup.shell_command_prefix);
}

/// Restore every shell override written by the removed WSL mode and persist the
/// runtime as native. The desktop calls this before starting Tauri and local Pi
/// startup calls it again, making transient lock failures safely retryable.
pub fn migrate_legacy_runtime_to_native() -> Result<bool, String> {
    let _guard = LEGACY_WSL_MIGRATION
        .lock()
        .map_err(|_| "legacy WSL migration lock is poisoned".to_owned())?;
    let process_lock_path = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join(".wsl-settings-sync.lock");
    let _process_guard = pi_backend_core::projects::CrossProcessFileLock::acquire(
        &process_lock_path,
        Duration::from_secs(5),
    )
    .map_err(|error| format!("legacy WSL migration unavailable: {error}"))?;

    let mut config = crate::projects::runtime_config()?;
    let backups = crate::projects::legacy_project_shell_backups()?;
    let needs_migration =
        config.mode == RuntimeMode::Wsl || config.native_shell_saved || !backups.is_empty();
    if !needs_migration {
        return Ok(false);
    }

    let bridge_path = shell_bridge_path()?;
    let global_settings = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("settings.json");
    if global_settings.is_file() {
        update_settings(&global_settings, |object| {
            restore_global_shell_settings(object, &config, &bridge_path);
            Ok(())
        })?;
    }

    for (root, backup) in &backups {
        let settings_path = PathBuf::from(root).join(".pi").join("settings.json");
        if !settings_path.is_file() {
            continue;
        }
        update_settings(&settings_path, |object| {
            restore_project_shell_settings(object, backup, &bridge_path);
            Ok(())
        })?;
    }

    config.mode = RuntimeMode::Native;
    config.distro.clear();
    config.native_shell_path = None;
    config.native_shell_command_prefix = None;
    config.native_shell_saved = false;
    crate::projects::complete_legacy_wsl_migration(config)?;
    Ok(true)
}

/// Handle the retired `<desktop.exe> -c <command>` shell invocation. This remains
/// only as an upgrade fallback for a legacy Pi process that was already running.
/// Returns `None` for a normal desktop launch.
pub fn run_shell_bridge_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("-c")) {
        return None;
    }
    let command = match args.next() {
        Some(value) => value,
        None => {
            eprintln!("Pi legacy WSL shell bridge expected a command after -c");
            return Some(2);
        }
    };

    let config = match crate::projects::runtime_config() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("Pi legacy WSL shell bridge could not read runtime state: {error}");
            return Some(2);
        }
    };
    if config.mode != RuntimeMode::Wsl {
        eprintln!("Pi legacy WSL shell bridge is no longer active");
        return Some(2);
    }
    let inherited_cwd = std::env::current_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let context = match resolve_context(&config, inherited_cwd.as_deref()) {
        Ok(context) => context,
        Err(error) => {
            eprintln!("{error}");
            return Some(2);
        }
    };

    let mut child = Command::new(wsl_executable());
    append_context_args(&mut child, &context);
    // Pi already combines stdout and stderr into one BashResult. Merge Linux
    // stderr inside Bash, then discard wsl.exe's repetitive host warnings.
    let command = format!("{{\n{}\n}} 2>&1", command.to_string_lossy());
    child
        .args(["--exec", "bash", "-lc"])
        .arg(command)
        .stderr(Stdio::piped());
    hide_window(&mut child);
    let mut child = match child.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("failed to execute legacy command in WSL: {error}");
            return Some(1);
        }
    };
    let diagnostic_reader = child.stderr.take().map(|mut stderr| {
        std::thread::spawn(move || {
            const MAX_DIAGNOSTIC_BYTES: usize = 16 * 1024;
            let mut kept = Vec::new();
            let mut chunk = [0_u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let remaining = MAX_DIAGNOSTIC_BYTES.saturating_sub(kept.len());
                        kept.extend_from_slice(&chunk[..read.min(remaining)]);
                    }
                }
            }
            kept
        })
    });
    match child.wait() {
        Ok(status) => {
            let diagnostics = diagnostic_reader
                .and_then(|reader| reader.join().ok())
                .unwrap_or_default();
            if !status.success() {
                let diagnostic = actionable_wsl_diagnostic(&diagnostics);
                if !diagnostic.is_empty() {
                    eprintln!("{diagnostic}");
                }
            }
            Some(status.code().unwrap_or(1))
        }
        Err(error) => {
            eprintln!("failed to wait for legacy WSL command: {error}");
            Some(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(distro: &str) -> RuntimeConfig {
        RuntimeConfig {
            mode: RuntimeMode::Wsl,
            distro: distro.into(),
            ..RuntimeConfig::default()
        }
    }

    #[test]
    fn compatibility_bridge_keeps_windows_cwd_for_wsl_mapping() {
        let context = resolve_context(&config("Ubuntu"), Some("D:/work/project")).unwrap();
        assert_eq!(context.distro, "Ubuntu");
        assert_eq!(context.cwd.as_deref(), Some("D:/work/project"));
    }

    #[test]
    fn compatibility_bridge_converts_wsl_unc_and_derives_distro() {
        let context = resolve_context(
            &config(""),
            Some("//wsl.localhost/Ubuntu-24.04/home/user/project"),
        )
        .unwrap();
        assert_eq!(context.distro, "Ubuntu-24.04");
        assert_eq!(context.cwd.as_deref(), Some("/home/user/project"));
    }

    #[test]
    fn recognizes_only_the_old_generated_direct_wsl_override() {
        let legacy = serde_json::json!(["-d", "Ubuntu", "--", "bash"]);
        assert!(is_legacy_wsl_override(
            Some("C:/Windows/System32/wsl.exe"),
            Some(&legacy)
        ));
        assert!(!is_legacy_wsl_override(
            Some("C:/custom/bash.exe"),
            Some(&legacy)
        ));
        assert!(!is_legacy_wsl_override(
            Some("C:/Windows/System32/wsl.exe"),
            Some(&serde_json::json!("custom prefix"))
        ));
    }

    #[test]
    fn migration_restores_saved_global_shell_settings() {
        let mut settings = serde_json::json!({
            "shellPath": "C:/Pi/pi-desktop.exe"
        });
        let config = RuntimeConfig {
            mode: RuntimeMode::Wsl,
            native_shell_path: Some("C:/custom/bash.exe".into()),
            native_shell_command_prefix: Some("source ~/.profile".into()),
            native_shell_saved: true,
            ..RuntimeConfig::default()
        };

        restore_global_shell_settings(
            settings.as_object_mut().unwrap(),
            &config,
            "C:/Pi/pi-desktop.exe",
        );

        assert_eq!(settings["shellPath"], "C:/custom/bash.exe");
        assert_eq!(settings["shellCommandPrefix"], "source ~/.profile");
    }

    #[test]
    fn migration_does_not_overwrite_a_manual_shell_change() {
        let mut settings = serde_json::json!({
            "shellPath": "C:/new/bash.exe",
            "shellCommandPrefix": "new-prefix"
        });
        let before = settings.clone();
        let config = RuntimeConfig {
            mode: RuntimeMode::Wsl,
            native_shell_path: Some("C:/old/bash.exe".into()),
            native_shell_saved: true,
            ..RuntimeConfig::default()
        };

        restore_global_shell_settings(
            settings.as_object_mut().unwrap(),
            &config,
            "C:/Pi/pi-desktop.exe",
        );

        assert_eq!(settings, before);
    }

    #[test]
    fn migration_restores_project_backup_only_for_managed_bridge() {
        let backup = crate::projects::ShellSettingsBackup {
            shell_path: Some(serde_json::json!("C:/project/bash.exe")),
            shell_command_prefix: Some(serde_json::json!(["--login"])),
        };
        let mut settings = serde_json::json!({
            "shellPath": "C:/Pi/pi-desktop.exe"
        });

        restore_project_shell_settings(
            settings.as_object_mut().unwrap(),
            &backup,
            "C:/Pi/pi-desktop.exe",
        );

        assert_eq!(settings["shellPath"], "C:/project/bash.exe");
        assert_eq!(
            settings["shellCommandPrefix"],
            serde_json::json!(["--login"])
        );
    }
}
