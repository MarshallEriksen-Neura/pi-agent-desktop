use pi_remote_control::protocol::RemoteTaskContextFile;
use pi_remote_control::task_runtime::{
    RemoteTaskInput, RemoteTaskRuntime, RemoteTaskRuntimeConfig, RuntimeEvent, RuntimeTerminal,
};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn fixture_dir(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("ragcode-pi-stage5-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn input(root: PathBuf) -> RemoteTaskInput {
    RemoteTaskInput {
        task_id: "task-stage5".into(),
        project_root: root,
        prompt: "inspect the selected project".into(),
        context_files: Vec::new(),
    }
}

#[cfg(windows)]
fn output_process(command: &str) -> RemoteTaskRuntimeConfig {
    RemoteTaskRuntimeConfig::with_fixed_command(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
    )
}

#[cfg(unix)]
fn output_process(command: &str) -> RemoteTaskRuntimeConfig {
    RemoteTaskRuntimeConfig::with_fixed_command("sh", ["-c", command])
}

#[test]
fn dedicated_runtime_translates_fake_pi_output_and_terminal() {
    let root = fixture_dir("output");
    let command = if cfg!(windows) {
        r#"Write-Output '{"type":"agent_start"}'; Write-Output '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"safe output"}}'; Write-Output '{"type":"agent_end"}'"#
    } else {
        r#"printf '%s\n' '{"type":"agent_start"}' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"safe output"}}' '{"type":"agent_end"}'"#
    };
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&events);
    let runtime =
        RemoteTaskRuntime::start(input(root.clone()), output_process(command), move |event| {
            observed.lock().unwrap().push(event)
        })
        .unwrap();
    let outcome = runtime.wait(Duration::from_secs(5)).unwrap();
    assert_eq!(outcome.terminal, RuntimeTerminal::Succeeded);
    assert!(outcome.output_bytes > 0);
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event, RuntimeEvent::Output { fragment, .. } if fragment.contains("safe output"))));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn cancellation_stops_a_dedicated_runtime_within_bound() {
    let root = fixture_dir("cancel");
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    };
    let runtime =
        RemoteTaskRuntime::start(input(root.clone()), output_process(command), |_| {}).unwrap();
    std::thread::sleep(Duration::from_millis(50));
    runtime.cancel();
    let outcome = runtime.wait(Duration::from_secs(5)).unwrap();
    assert_eq!(outcome.terminal, RuntimeTerminal::Cancelled);
    assert!(outcome.process_exit.is_some());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn execution_deadline_is_bounded_and_cleans_the_process() {
    let root = fixture_dir("deadline");
    let command = if cfg!(windows) {
        "Start-Sleep -Seconds 30"
    } else {
        "sleep 30"
    };
    let config = RemoteTaskRuntimeConfig {
        execution_deadline: Duration::from_millis(50),
        stop_timeout: Duration::from_secs(2),
        ..output_process(command)
    };
    let runtime = RemoteTaskRuntime::start(input(root.clone()), config, |_| {}).unwrap();
    let outcome = runtime.wait(Duration::from_secs(5)).unwrap();
    assert_eq!(outcome.terminal, RuntimeTerminal::TimedOut);
    assert!(outcome.process_exit.is_some());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn context_validation_rejects_escape_and_sensitive_files_before_spawn() {
    let root = fixture_dir("context");
    fs::write(root.join("safe.txt"), "safe").unwrap();
    fs::write(root.join(".env"), "secret").unwrap();
    let mut request = input(root.clone());
    request.context_files = vec![RemoteTaskContextFile {
        relative_path: "../outside.txt".into(),
    }];
    assert!(RemoteTaskRuntime::start(request, output_process("exit 0"), |_| {}).is_err());
    let mut request = input(root.clone());
    request.context_files = vec![RemoteTaskContextFile {
        relative_path: ".env".into(),
    }];
    assert!(RemoteTaskRuntime::start(request, output_process("exit 0"), |_| {}).is_err());
    let _ = fs::remove_dir_all(root);
}
