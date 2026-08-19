//! Locate and spawn a Chromium-based browser (Chrome/Edge) for CDP control.

use std::path::PathBuf;
use std::process::Child;
use std::time::Duration;

const CANDIDATES: &[&str] = &[
    // Windows Chrome / Edge
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"$LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    r"$LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
    // macOS Chrome / Edge
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    // Linux Chrome / Chromium
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
];

/// Find the first existing browser executable.
pub fn find_browser() -> Option<PathBuf> {
    for raw in CANDIDATES {
        let candidate = if let Some(stripped) = raw.strip_prefix("$LOCALAPPDATA") {
            match std::env::var("LOCALAPPDATA") {
                Ok(base) => PathBuf::from(base).join(stripped.trim_start_matches('\\')),
                Err(_) => continue,
            }
        } else {
            PathBuf::from(raw)
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // PATH lookup as a last resort.
    if let Ok(path) = std::env::var("PATH") {
        for name in ["chrome", "google-chrome", "chromium", "msedge", "microsoft-edge"] {
            for dir in path.split(';') {
                let candidate = PathBuf::from(dir).join(format!("{name}.exe"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Spawn the browser on a random free port with a fresh user-data dir.
/// Returns (Child, port) once the CDP endpoint responds.
pub fn spawn_browser(executable: &PathBuf, user_data_dir: &PathBuf) -> Result<(Child, u16), String> {
    let port = pick_free_port().map_err(|e| format!("no free port: {e}"))?;
    let mut cmd = std::process::Command::new(executable);
    cmd.args([
        format!("--remote-debugging-port={port}"),
        format!("--user-data-dir={}", user_data_dir.display()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-features=Translate,OptimizationHints".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-component-update".to_string(),
        "--disable-sync".to_string(),
        "about:blank".to_string(),
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — keep the spawned Chrome console-less.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", executable.display()))?;

    // Wait for the CDP endpoint to come up.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok((child, port));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    kill_tree(&mut child);
    Err(format!("browser at {} did not open a CDP endpoint", executable.display()))
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Kill a Chromium process and its entire descendant tree.
///
/// Windows Chrome spawns a multi-process tree (browser + gpu + renderers); a
/// plain `Child::kill()` only stops the browser process and can orphan the
/// rest. `taskkill /T /F` tears the whole tree down.
pub fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id();
        let ok = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            let _ = child.wait();
            return;
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
