//! Read/write pi's settings.json and run pi package-management CLI commands.
//!
//! pi resolves its config the same way on every platform: `homedir()/.pi/agent`
//! for global settings, `<cwd>/.pi` for project settings. RPC mode has no
//! settings commands, so the desktop app edits the JSON files directly and
//! restarts pi to apply.

use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    #[cfg(windows)]
    const VAR: &str = "USERPROFILE";
    #[cfg(not(windows))]
    const VAR: &str = "HOME";
    std::env::var(VAR)
        .map(PathBuf::from)
        .map_err(|_| format!("{VAR} is not set"))
}

/// `root` is the currently open project (frontend-provided); the process cwd
/// is only a fallback for callers that predate project selection.
fn settings_path(scope: &str, root: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(home_dir()?.join(".pi").join("agent").join("settings.json")),
        // custom model/provider definitions — global only, no project override
        "models" => Ok(home_dir()?.join(".pi").join("agent").join("models.json")),
        "project" => match root {
            Some(r) => Ok(PathBuf::from(r).join(".pi").join("settings.json")),
            None => std::env::current_dir()
                .map(|d| d.join(".pi").join("settings.json"))
                .map_err(|e| e.to_string()),
        },
        other => Err(format!("unknown settings scope: {other}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
}

#[tauri::command]
pub fn pi_settings_read(scope: String, root: Option<String>) -> Result<SettingsFile, String> {
    let path = settings_path(&scope, root.as_deref())?;
    let exists = path.is_file();
    let content = if exists {
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    Ok(SettingsFile {
        path: path.to_string_lossy().replace('\\', "/"),
        exists,
        content,
    })
}

#[tauri::command]
pub fn pi_settings_write(scope: String, content: String, root: Option<String>) -> Result<(), String> {
    // settings.json is shared with the pi CLI — never write something it can't parse
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("refusing to write invalid JSON: {e}"))?;

    let path = settings_path(&scope, root.as_deref())?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // write temp + rename so a crash can't leave a truncated settings.json
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run the pi CLI for package management. Restricted to non-interactive
/// package subcommands so a bad frontend call can't start a TUI that hangs
/// waiting for a terminal.
#[tauri::command]
pub fn pi_cli(args: Vec<String>, cwd: Option<String>) -> Result<CliResult, String> {
    const ALLOWED: &[&str] = &["install", "remove", "uninstall", "list", "update"];
    match args.first().map(String::as_str) {
        Some(sub) if ALLOWED.contains(&sub) => {}
        _ => return Err("only pi package subcommands are allowed".into()),
    }

    let mut cmd = Command::new("pi");
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("failed to run pi: {e}"))?;
    Ok(CliResult {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}
