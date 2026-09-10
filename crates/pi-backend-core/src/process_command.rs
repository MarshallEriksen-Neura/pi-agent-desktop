//! Cross-platform policy for child processes that never own an interactive terminal.

use std::process::Command;

/// Configure a background child process so it cannot allocate a visible console
/// over the Windows desktop application. This is intentionally a no-op elsewhere.
pub fn configure_headless(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

/// Apply [`configure_headless`] when the launch specification requests it.
pub fn configure_headless_if(command: &mut Command, enabled: bool) {
    if enabled {
        configure_headless(command);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::configure_headless;
    use std::process::Command;

    #[test]
    fn configured_children_do_not_allocate_a_windows_console() {
        let probe = r#"
Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
if ([Win32.NativeMethods]::GetConsoleWindow() -eq [IntPtr]::Zero) { exit 0 }
exit 1
"#;
        let mut command = Command::new("powershell.exe");
        command
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(probe);
        configure_headless(&mut command);

        let output = command.output().expect("run child console probe");
        assert!(
            output.status.success(),
            "child allocated a console: stdout={}, stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
