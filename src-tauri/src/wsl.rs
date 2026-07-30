//! WSL command-environment support.
//!
//! Pi expects a custom shell to accept `-c <command>`, while `wsl.exe` uses a
//! different argument contract. The desktop executable therefore doubles as a
//! small shell bridge: when Pi starts it with `-c`, it forwards the command to
//! Bash inside the selected WSL distro and exits without starting Tauri.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeMode {
    #[default]
    Native,
    Wsl,
}

/// App-owned command runtime config, persisted in `desktop.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimeConfig {
    pub mode: RuntimeMode,
    /// WSL distro name (for example `Ubuntu-24.04`); empty means the default.
    pub distro: String,
    /// Native Pi shell settings saved before WSL mode replaced them.
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

/// Convert a Windows WSL UNC project root to its Linux path. For local Windows
/// paths, `wsl.exe --cd` performs the drive mapping itself.
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
                "project belongs to WSL distro `{path_distro}`, but runtime uses `{distro}`"
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
    // wsl.exe diagnostics use the Windows console encoding by default, while
    // Linux command output is UTF-8. Force one encoding so Pi never receives
    // UTF-16 NUL bytes mixed into terminal output.
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

#[cfg(windows)]
fn output_with_timeout(
    mut cmd: Command,
    timeout: Duration,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to start wsl.exe: {error}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            break status;
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "wsl.exe did not respond within {} seconds",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_end(&mut stdout)
            .map_err(|error| error.to_string())?;
    }
    if let Some(mut pipe) = child.stderr.take() {
        pipe.read_to_end(&mut stderr)
            .map_err(|error| error.to_string())?;
    }
    Ok((status, stdout, stderr))
}

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

/// Decode `wsl.exe -l -q`, which writes UTF-16LE on Windows.
#[cfg(windows)]
fn decode_wsl_list(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
}

/// List installed WSL distros. An empty list means WSL is unavailable.
#[tauri::command]
pub fn wsl_list_distros() -> Result<Vec<String>, String> {
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new(wsl_executable());
        cmd.args(["-l", "-q"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        hide_window(&mut cmd);

        let (_, stdout, _) = match output_with_timeout(cmd, Duration::from_secs(3)) {
            Ok(output) if output.0.success() => output,
            Ok(_) => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        Ok(decode_wsl_list(&stdout)
            .lines()
            .map(|line| line.trim().trim_end_matches('\r').replace('\0', ""))
            .filter(|line| !line.is_empty())
            .collect())
    }
}

/// Absolute path Pi should use for `shellPath` in WSL mode.
#[tauri::command]
pub fn wsl_shell_bridge_path() -> Result<String, String> {
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

fn read_settings(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let settings = if path.is_file() {
        let content = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str::<serde_json::Value>(&content)
            .map_err(|error| format!("cannot update {}: {error}", path.display()))?
    } else {
        serde_json::json!({})
    };
    if settings.is_object() {
        Ok(settings)
    } else {
        Err(format!(
            "cannot update {}: root must be a JSON object",
            path.display()
        ))
    }
}

fn write_settings(path: &std::path::Path, settings: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(path, format!("{content}\n")).map_err(|error| error.to_string())
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

fn install_project_bridge(
    object: &mut serde_json::Map<String, serde_json::Value>,
    bridge_path: &str,
) -> crate::projects::ShellSettingsBackup {
    let bridge_was_already_managed =
        object.get("shellPath").and_then(serde_json::Value::as_str) == Some(bridge_path);
    let backup = crate::projects::ShellSettingsBackup {
        shell_path: (!bridge_was_already_managed)
            .then(|| object.get("shellPath").cloned())
            .flatten(),
        shell_command_prefix: (!bridge_was_already_managed)
            .then(|| object.get("shellCommandPrefix").cloned())
            .flatten(),
    };
    object.insert(
        "shellPath".into(),
        serde_json::Value::String(bridge_path.into()),
    );
    object.remove("shellCommandPrefix");
    backup
}

fn sync_project_shell_settings(
    config: &RuntimeConfig,
    root: &str,
    bridge_path: &str,
) -> Result<(), String> {
    let path = PathBuf::from(root).join(".pi").join("settings.json");
    let backup = crate::projects::project_shell_backup(root);

    if config.mode == RuntimeMode::Native {
        let Some(backup) = backup else {
            return Ok(());
        };
        let mut settings = read_settings(&path)?;
        let object = settings.as_object_mut().expect("validated settings object");
        restore_setting(object, "shellPath", &backup.shell_path);
        restore_setting(object, "shellCommandPrefix", &backup.shell_command_prefix);
        write_settings(&path, &settings)?;
        return crate::projects::project_shell_backup_remove(root);
    }

    if !path.is_file() {
        return Ok(());
    }
    let mut settings = read_settings(&path)?;
    let object = settings.as_object_mut().expect("validated settings object");
    let has_override =
        object.contains_key("shellPath") || object.contains_key("shellCommandPrefix");
    if !has_override && backup.is_none() {
        return Ok(());
    }

    if backup.is_none() {
        let backup = install_project_bridge(object, bridge_path);
        crate::projects::project_shell_backup_write(root, backup)?;
    } else {
        object.insert(
            "shellPath".into(),
            serde_json::Value::String(bridge_path.into()),
        );
        object.remove("shellCommandPrefix");
    }
    write_settings(&path, &settings)
}

/// Synchronize global and current-project shell overrides before Pi reads its
/// settings. This migrates the old direct-wsl.exe shape and restores both
/// scopes when the runtime returns to native mode.
pub fn sync_shell_bridge_settings(cwd: Option<&str>) -> Result<(), String> {
    let mut config = crate::projects::runtime_config();
    let path = crate::pi_settings::home_dir()?
        .join(".pi")
        .join("agent")
        .join("settings.json");
    let mut settings = read_settings(&path)?;
    let object = settings.as_object_mut().expect("validated settings object");
    let current_path = object.get("shellPath").and_then(serde_json::Value::as_str);
    let current_prefix = object.get("shellCommandPrefix");
    let bridge_path = wsl_shell_bridge_path()?;

    if config.mode == RuntimeMode::Wsl {
        if !config.native_shell_saved {
            if !is_legacy_wsl_override(current_path, current_prefix)
                && current_path != Some(bridge_path.as_str())
            {
                config.native_shell_path = current_path.map(str::to_string);
                config.native_shell_command_prefix = current_prefix
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
            }
            config.native_shell_saved = true;
            crate::projects::runtime_config_write(config.clone())?;
        }
        object.insert(
            "shellPath".into(),
            serde_json::Value::String(bridge_path.clone()),
        );
        object.remove("shellCommandPrefix");
        write_settings(&path, &settings)?;
    } else if config.native_shell_saved {
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
        write_settings(&path, &settings)?;
        config.native_shell_path = None;
        config.native_shell_command_prefix = None;
        config.native_shell_saved = false;
        crate::projects::runtime_config_write(config.clone())?;
    }

    if let Some(root) = cwd {
        sync_project_shell_settings(&config, root, &bridge_path)?;
    }
    Ok(())
}

pub fn validate_project_path(config: &RuntimeConfig, root: &str) -> Result<(), String> {
    if config.mode == RuntimeMode::Wsl {
        resolve_context(config, Some(root)).map(|_| ())
    } else {
        Ok(())
    }
}

/// Validate WSL, the selected distro, Bash, and project cwd before persisting a
/// runtime change. Native mode has no additional prerequisites.
#[tauri::command]
pub fn wsl_runtime_validate(config: RuntimeConfig, cwd: Option<String>) -> Result<(), String> {
    if config.mode != RuntimeMode::Wsl {
        return Ok(());
    }
    #[cfg(not(windows))]
    return Err("WSL runtime is only available on Windows".into());

    #[cfg(windows)]
    {
        let context = resolve_context(&config, cwd.as_deref())?;
        let mut cmd = Command::new(wsl_executable());
        append_context_args(&mut cmd, &context);
        cmd.args(["--exec", "bash", "-lc", "exit 0"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        hide_window(&mut cmd);
        let (status, _, stderr) = output_with_timeout(cmd, Duration::from_secs(5))?;
        if status.success() {
            Ok(())
        } else {
            let distro = if context.distro.is_empty() {
                "the default distro"
            } else {
                context.distro.as_str()
            };
            let diagnostic = actionable_wsl_diagnostic(&stderr);
            let detail = if diagnostic.is_empty() {
                "verify that WSL and Bash are installed".to_string()
            } else {
                diagnostic
            };
            Err(format!("could not start Bash in {distro}: {detail}"))
        }
    }
}

/// Handle the special `<desktop.exe> -c <command>` shell invocation used by
/// Pi. Returns `None` for a normal desktop launch.
pub fn run_shell_bridge_if_requested() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("-c")) {
        return None;
    }
    let command = match args.next() {
        Some(value) => value,
        None => {
            eprintln!("Pi WSL shell bridge expected a command after -c");
            return Some(2);
        }
    };

    let config = crate::projects::runtime_config();
    if config.mode != RuntimeMode::Wsl {
        eprintln!("Pi WSL shell bridge was invoked while the runtime is native");
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
    // stderr inside Bash, then discard wsl.exe's own repetitive host warnings.
    let command = format!("{{\n{}\n}} 2>&1", command.to_string_lossy());
    child
        .args(["--exec", "bash", "-lc"])
        .arg(command)
        .stderr(Stdio::piped());
    hide_window(&mut child);
    let mut child = match child.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("failed to execute command in WSL: {error}");
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
            eprintln!("failed to wait for WSL command: {error}");
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
    fn keeps_windows_project_for_wsl_cd_mapping() {
        let context = resolve_context(&config("Ubuntu"), Some("D:/work/project")).unwrap();
        assert_eq!(context.distro, "Ubuntu");
        assert_eq!(context.cwd.as_deref(), Some("D:/work/project"));
    }

    #[test]
    fn converts_wsl_unc_project_and_derives_distro() {
        let context = resolve_context(
            &config(""),
            Some("//wsl.localhost/Ubuntu-24.04/home/user/project"),
        )
        .unwrap();
        assert_eq!(context.distro, "Ubuntu-24.04");
        assert_eq!(context.cwd.as_deref(), Some("/home/user/project"));
    }

    #[test]
    fn rejects_project_from_another_distro() {
        let error = resolve_context(
            &config("Ubuntu"),
            Some(r"\\wsl.localhost\Debian\home\user\project"),
        )
        .unwrap_err();
        assert!(error.contains("project belongs to WSL distro `Debian`"));
    }

    #[test]
    fn recognizes_only_the_old_generated_wsl_override() {
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
    fn project_override_is_replaced_and_preserved_for_restore() {
        let mut settings = serde_json::json!({
            "shellPath": "C:/custom/bash.exe",
            "shellCommandPrefix": "source ~/.profile"
        });
        let object = settings.as_object_mut().unwrap();
        let backup = install_project_bridge(object, "C:/Pi/pi-desktop.exe");

        assert_eq!(
            object.get("shellPath").and_then(serde_json::Value::as_str),
            Some("C:/Pi/pi-desktop.exe")
        );
        assert!(!object.contains_key("shellCommandPrefix"));
        assert_eq!(
            backup.shell_path,
            Some(serde_json::json!("C:/custom/bash.exe"))
        );
        assert_eq!(
            backup.shell_command_prefix,
            Some(serde_json::json!("source ~/.profile"))
        );
    }
}
