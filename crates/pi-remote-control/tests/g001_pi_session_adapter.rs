use pi_remote_control::pi_session::{
    PiSessionAdapter, PiSessionConfig, PiSessionContext, PiSessionErrorCode,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn fixture_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("ragcode-pi-g001-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn fake_pi() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_fake_pi_session_fixture"))
}

fn config(root: &Path) -> PiSessionConfig {
    PiSessionConfig {
        stop_timeout: Duration::from_secs(2),
        rpc_timeout: Duration::from_secs(2),
        ..PiSessionConfig::new(fake_pi().into_os_string(), root.join("private-sessions"))
    }
}

fn context(root: &Path) -> PiSessionContext {
    let project = root.join("project");
    fs::create_dir_all(&project).unwrap();
    PiSessionContext {
        owner_device_id: "owner-device".into(),
        conversation_id: "conversation-g001".into(),
        project_id: "project-g001".into(),
        project_root: project,
    }
}

#[test]
fn creates_private_session_and_resumes_two_prompts_after_cold_restart() {
    let root = fixture_dir("resume");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    assert_eq!(probe.pi_version, "0.84.1");
    let adapter = PiSessionAdapter::new(config.clone(), probe).unwrap();

    let mut first = adapter.start(context.clone()).unwrap();
    assert!(first.state().is_none());
    first.prompt_and_wait_settled("first prompt").unwrap();
    let binding = first.state().unwrap().binding.clone();
    first.shutdown().unwrap();

    let mut second = adapter.resume(context.clone(), &binding).unwrap();
    second.prompt_and_wait_settled("second prompt").unwrap();
    let state = second.state().unwrap().binding.clone();
    second.shutdown().unwrap();

    assert_eq!(
        state.session_id_for_storage(),
        binding.session_id_for_storage()
    );
    let session_file = config.session_root.join(
        state
            .relative_ref_for_storage()
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    let prompts = prompt_messages(&session_file);
    assert_eq!(prompts, vec!["first prompt", "second prompt"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn repeated_start_does_not_replay_prior_prompt() {
    let root = fixture_dir("exactly-once");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    let adapter = PiSessionAdapter::new(config.clone(), probe).unwrap();

    let mut first = adapter.start(context.clone()).unwrap();
    assert!(first.state().is_none());
    first
        .prompt_and_wait_settled("only delivered explicitly")
        .unwrap();
    let binding = first.state().unwrap().binding.clone();
    first.shutdown().unwrap();

    let resumed = adapter.resume(context.clone(), &binding).unwrap();
    let session_file = config.session_root.join(
        binding
            .relative_ref_for_storage()
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    assert_eq!(
        prompt_messages(&session_file),
        vec!["only delivered explicitly"]
    );
    resumed.shutdown().unwrap();
    assert_eq!(
        prompt_messages(&session_file),
        vec!["only delivered explicitly"]
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn containment_failures_are_rejected_before_delivery() {
    let root = fixture_dir("containment");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    let adapter = PiSessionAdapter::new(config.clone(), probe).unwrap();
    let mut handle = adapter.start(context.clone()).unwrap();
    handle.prompt_and_wait_settled("baseline").unwrap();
    let mut binding = handle.state().unwrap().binding.clone();
    let session_file = config.session_root.join(
        binding
            .relative_ref_for_storage()
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    handle.shutdown().unwrap();

    binding.test_mutate_relative_ref("../outside.jsonl");
    let error = adapter.resume(context.clone(), &binding).unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);
    assert_eq!(prompt_messages(&session_file), vec!["baseline"]);

    let absolute = root.join("outside.jsonl");
    fs::write(&absolute, "{}\n").unwrap();
    binding.test_mutate_relative_ref(absolute.to_string_lossy().into_owned());
    let error = adapter.resume(context, &binding).unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);
    assert_eq!(prompt_messages(&session_file), vec!["baseline"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn owner_version_and_header_mismatches_fail_closed_before_delivery() {
    let root = fixture_dir("mismatch");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    let adapter = PiSessionAdapter::new(config.clone(), probe).unwrap();
    let mut handle = adapter.start(context.clone()).unwrap();
    handle.prompt_and_wait_settled("baseline").unwrap();
    let binding = handle.state().unwrap().binding.clone();
    let session_file = config.session_root.join(
        binding
            .relative_ref_for_storage()
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    handle.shutdown().unwrap();

    let mut owner_mismatch = binding.clone();
    owner_mismatch.test_mutate_owner("other-owner");
    let error = adapter
        .resume(context.clone(), &owner_mismatch)
        .unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);

    let mut version_mismatch = binding.clone();
    version_mismatch.test_mutate_version("0.0.0");
    let error = adapter
        .resume(context.clone(), &version_mismatch)
        .unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);

    let mut format_mismatch = binding.clone();
    format_mismatch.test_mutate_format("other-format");
    let error = adapter
        .resume(context.clone(), &format_mismatch)
        .unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);

    let original = fs::read_to_string(&session_file).unwrap();
    let mut lines = original.lines();
    let mut header: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
    header["cwd"] = Value::String(root.join("other-project").to_string_lossy().into_owned());
    fs::create_dir_all(root.join("other-project")).unwrap();
    fs::write(
        &session_file,
        format!("{}\n{}\n", header, lines.collect::<Vec<_>>().join("\n")),
    )
    .unwrap();
    let error = adapter.resume(context, &binding).unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);
    assert_eq!(prompt_messages(&session_file), vec!["baseline"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn symlink_session_material_fails_closed_before_delivery_when_supported() {
    let root = fixture_dir("symlink");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    let adapter = PiSessionAdapter::new(config.clone(), probe).unwrap();
    let mut handle = adapter.start(context.clone()).unwrap();
    handle.prompt_and_wait_settled("baseline").unwrap();
    let mut binding = handle.state().unwrap().binding.clone();
    let session_file = config.session_root.join(
        binding
            .relative_ref_for_storage()
            .replace('/', std::path::MAIN_SEPARATOR_STR),
    );
    let link = session_file.with_extension("link.jsonl");
    if create_file_link(&session_file, &link).is_err() {
        handle.shutdown().unwrap();
        let _ = fs::remove_dir_all(root);
        return;
    }
    let rel = link
        .strip_prefix(&config.session_root)
        .unwrap()
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/");
    binding.test_mutate_relative_ref(rel);
    handle.shutdown().unwrap();
    let error = adapter.resume(context, &binding).unwrap_err();
    assert_eq!(error.code(), &PiSessionErrorCode::SessionResumeUnavailable);
    assert_eq!(prompt_messages(&session_file), vec!["baseline"]);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn shutdown_is_bounded_and_debug_is_redacted() {
    let root = fixture_dir("shutdown");
    let context = context(&root);
    let config = config(&root);
    let probe = PiSessionAdapter::probe(config.clone(), context.clone()).unwrap();
    let adapter = PiSessionAdapter::new(config, probe).unwrap();
    let mut handle = adapter.start(context).unwrap();
    handle.prompt_and_wait_settled("debug prompt").unwrap();
    let debug = format!("{:?}", handle.state().unwrap().binding);
    assert!(debug.contains("<redacted>"));
    assert!(!debug.contains(".jsonl"));
    assert!(!debug.contains("owner-device/project-g001"));
    assert!(!format!("{:?}", handle).contains(".jsonl"));
    handle.shutdown().unwrap();
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore = "requires an installed Pi CLI; run explicitly as the local compatibility gate"]
fn real_installed_pi_canary_probe_is_healthy() {
    let root = fixture_dir("real-pi-probe");
    let context = context(&root);
    let node = std::env::var_os("RAGCODE_REAL_PI_NODE")
        .unwrap_or_else(|| std::ffi::OsString::from("node"));
    let cli = std::env::var_os("RAGCODE_REAL_PI_CLI")
        .expect("RAGCODE_REAL_PI_CLI must point to the installed Pi dist/cli.js");
    let config = PiSessionConfig::new(node, root.join("private-sessions")).with_prefix_args([cli]);

    let probe = PiSessionAdapter::probe(config, context).expect("installed Pi probe must pass");
    assert!(!probe.pi_version.trim().is_empty());
    assert!(probe.format_fingerprint.contains("jsonl-v3"));
    assert!(root.join("private-sessions").is_dir());
    assert!(
        fs::read_dir(root.join("private-sessions"))
            .unwrap()
            .next()
            .is_none(),
        "probe canary directory must be cleaned"
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
fn create_file_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[cfg(unix)]
fn create_file_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

fn prompt_messages(path: &Path) -> Vec<String> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            if value.get("type").and_then(Value::as_str) == Some("prompt_delivery") {
                value
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            }
        })
        .collect()
}
