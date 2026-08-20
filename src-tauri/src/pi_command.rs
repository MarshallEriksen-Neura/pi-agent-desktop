//! Cross-platform command construction for the Pi CLI.

use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

pub fn command(binary: Option<&str>) -> Result<Command, String> {
    let binary = binary
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("pi");

    #[cfg(windows)]
    let program = resolve_windows_program(binary)?;
    #[cfg(not(windows))]
    let program = PathBuf::from(binary);

    Ok(Command::new(program))
}

/// Resolve a bare program name to an executable path on PATH (any platform).
/// Windows searches `PATHEXT` (so npm shims like `npm.cmd` resolve) and falls
/// back to the user's npm prefix, mirroring how `pi` itself is located.
pub fn resolve_executable(binary: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        resolve_windows_program(binary).ok()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::var_os("PATH")?;
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join(binary);
            let executable = candidate
                .metadata()
                .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false);
            if executable {
                return Some(candidate);
            }
        }
        None
    }
}

#[cfg(windows)]
fn resolve_windows_program(binary: &str) -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let path_ext = std::env::var_os("PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
    let npm_prefix = std::env::var_os("APPDATA").map(|value| PathBuf::from(value).join("npm"));

    resolve_windows_program_from(binary, &path, &path_ext, npm_prefix.as_deref()).ok_or_else(|| {
        format!(
            "Pi CLI `{binary}` was not found. Install it with `npm install -g @earendil-works/pi-coding-agent` and restart Pi."
        )
    })
}

#[cfg(windows)]
fn resolve_windows_program_from(
    binary: &str,
    path: &std::ffi::OsStr,
    path_ext: &std::ffi::OsStr,
    npm_prefix: Option<&Path>,
) -> Option<PathBuf> {
    let requested = Path::new(binary);
    if requested.components().count() > 1 || requested.is_absolute() {
        return requested.is_file().then(|| requested.to_path_buf());
    }

    let extensions = windows_extensions(path_ext);
    let mut directories: Vec<PathBuf> = std::env::split_paths(path).collect();
    if let Some(prefix) = npm_prefix {
        if !directories.iter().any(|directory| directory == prefix) {
            directories.push(prefix.to_path_buf());
        }
    }

    for directory in directories {
        if requested.extension().is_some() {
            let exact = directory.join(requested);
            if exact.is_file() {
                return Some(exact);
            }
        } else {
            for extension in &extensions {
                let candidate = directory.join(format!("{binary}{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Best-effort location of npm's global bin directory, where `npm install -g`
/// drops CLI shims (e.g. `agent-browser.cmd` on Windows).
fn npm_bin_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // npm's default Windows prefix: %APPDATA%\npm (matches the fallback in
        // `resolve_windows_program` above).
        let appdata = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(appdata).join("npm"))
    }
    #[cfg(not(windows))]
    {
        // Common non-sudo setup: ~/.npm-global/bin. Normal npm prefixes are
        // already on PATH for Unix, so this is only a best-effort convenience.
        let home = std::env::var_os("HOME")?;
        let local = PathBuf::from(home).join(".npm-global").join("bin");
        local.is_dir().then_some(local)
    }
}

/// Compute PATH with `npm_bin` prepended, or `None` when it is already present.
fn with_npm_bin_prepended(path: &std::ffi::OsStr, npm_bin: &Path) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = std::env::split_paths(path).collect();
    if directories.iter().any(|directory| directory == npm_bin) {
        return None;
    }
    directories.insert(0, npm_bin.to_path_buf());
    std::env::join_paths(directories).ok()
}

/// Prepend npm's global bin directory to `cmd`'s PATH so pi and the processes
/// it spawns (e.g. the `pi-agent-browser-native` wrapper launching
/// `agent-browser.cmd` through PowerShell) can resolve npm-installed CLIs even
/// when the npm prefix is missing from the inherited PATH.
pub fn prepend_npm_bin_to_path(cmd: &mut Command) {
    let Some(npm_bin) = npm_bin_dir() else { return };
    let Some(path) = std::env::var_os("PATH") else { return };
    if let Some(joined) = with_npm_bin_prepended(&path, &npm_bin) {
        cmd.env("PATH", joined);
    }
}

#[cfg(windows)]
fn windows_extensions(path_ext: &std::ffi::OsStr) -> Vec<String> {
    path_ext
        .to_string_lossy()
        .split(';')
        .filter_map(|value| {
            let value = value.trim();
            if value.is_empty() {
                None
            } else if value.starts_with('.') {
                Some(value.to_ascii_lowercase())
            } else {
                Some(format!(".{}", value.to_ascii_lowercase()))
            }
        })
        .collect()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("pi-desktop-{label}-{nonce}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn resolves_npm_cmd_shim_from_path() {
        let directory = temp_dir("cmd-path");
        let unix_shim = directory.join("pi");
        let shim = directory.join("pi.cmd");
        fs::write(&unix_shim, "#!/usr/bin/env node\n").unwrap();
        fs::write(&shim, "@echo off\r\n").unwrap();

        let resolved = resolve_windows_program_from(
            "pi",
            directory.as_os_str(),
            OsStr::new(".EXE;.CMD"),
            None,
        );

        assert_eq!(resolved.as_deref(), Some(shim.as_path()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn falls_back_to_the_user_npm_prefix() {
        let empty_path = temp_dir("empty-path");
        let npm_prefix = temp_dir("npm-prefix");
        let shim = npm_prefix.join("pi.cmd");
        fs::write(&shim, "@echo off\r\n").unwrap();

        let resolved = resolve_windows_program_from(
            "pi",
            empty_path.as_os_str(),
            OsStr::new(".CMD"),
            Some(&npm_prefix),
        );

        assert_eq!(resolved.as_deref(), Some(shim.as_path()));
        fs::remove_dir_all(empty_path).unwrap();
        fs::remove_dir_all(npm_prefix).unwrap();
    }

    #[test]
    fn preserves_pathext_precedence() {
        let directory = temp_dir("precedence");
        let exe = directory.join("pi.exe");
        let cmd = directory.join("pi.cmd");
        fs::write(&exe, []).unwrap();
        fs::write(&cmd, "@echo off\r\n").unwrap();

        let resolved = resolve_windows_program_from(
            "pi",
            directory.as_os_str(),
            OsStr::new(".CMD;.EXE"),
            None,
        );

        assert_eq!(resolved.as_deref(), Some(cmd.as_path()));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn prepends_npm_bin_without_duplicating() {
        use std::ffi::OsStr;

        let npm_bin = PathBuf::from("C:/npm-prefix");
        let plain = with_npm_bin_prepended(OsStr::new("C:/tools;D:/bin"), &npm_bin)
            .expect("npm bin should be prepended");
        let dirs: Vec<PathBuf> = std::env::split_paths(&plain).collect();
        assert_eq!(dirs[0], npm_bin);
        assert_eq!(dirs.len(), 3);

        // Already on PATH — no mutation.
        let duplicate = with_npm_bin_prepended(OsStr::new("C:/npm-prefix;D:/bin"), &npm_bin);
        assert!(duplicate.is_none());
    }
}
