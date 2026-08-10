use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::gateway::{build_router, GatewayState};
use pi_remote_control::identity::{create_initial_identity, InMemoryIdentityStore};
use pi_remote_control::project_catalog::PersistedProject;
use pi_remote_control::protocol::{RemoteEvent, RemoteTaskContextFile, RemoteTaskCreateRequest};
use pi_remote_control::task_runtime::RemoteTaskRuntimeConfig;
use std::fs;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tower::ServiceExt;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_millis() as u64
}

fn fake_runtime() -> RemoteTaskRuntimeConfig {
    #[cfg(windows)]
    {
        RemoteTaskRuntimeConfig::with_fixed_command(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"Write-Output '{"type":"agent_start"}'; Write-Output '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"stage7 output"}}'; Write-Output '{"type":"agent_end"}'"#,
            ],
        )
    }
    #[cfg(not(windows))]
    {
        RemoteTaskRuntimeConfig::with_fixed_command(
            "sh",
            [
                "-c",
                r#"printf '%s\n' '{"type":"agent_start"}' '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"stage7 output"}}' '{"type":"agent_end"}'"#,
            ],
        )
    }
}

fn state(path: &std::path::Path) -> GatewayState {
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-stage7", vec!["localhost".into()])
            .expect("identity");
    GatewayState::with_runtime_config_and_storage(
        identity,
        Arc::new(DeviceRegistry::new()),
        "stage7",
        fake_runtime(),
        path,
    )
    .expect("storage")
}

fn authenticated_request(uri: &str, device_id: &str, token: &str, body: Vec<u8>) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("x-pi-device-id", device_id)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(body))
        .expect("request")
}

fn register(state: &GatewayState) -> (String, String) {
    let device = state
        .devices
        .register(
            pi_remote_control::protocol::PairingDeviceMetadata {
                device_id: "stage7-device".into(),
                display_name: "Stage 7 device".into(),
                platform: pi_remote_control::protocol::PairingDevicePlatform::Ios,
                app_version: None,
            },
            now_ms(),
        )
        .expect("device");
    (device.device_id, device.token)
}

#[tokio::test]
async fn post_task_runs_dedicated_runtime_and_persists_terminal_snapshot_and_events() {
    let root = std::env::temp_dir().join(format!("ragcode-pi-stage7-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("root");
    fs::write(root.join("main.rs"), "fn main() {}\n").expect("context file");
    let db = root.join("remote-control.sqlite3");
    let state = state(&db);
    let project = state
        .projects
        .allow_project(&root, "stage7-project", None)
        .expect("project");
    let (device_id, token) = register(&state);
    let router = build_router(state.clone());
    let request = RemoteTaskCreateRequest {
        request_id: "stage7-request".into(),
        project_id: project.project_id,
        prompt: "run the stage 7 fixture".into(),
        context_files: vec![RemoteTaskContextFile {
            relative_path: "main.rs".into(),
        }],
        execution_profile: None,
    };
    let response = router
        .oneshot(authenticated_request(
            "/api/v1/tasks",
            &device_id,
            &token,
            serde_json::to_vec(&request).expect("request json"),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot: serde_json::Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("snapshot json");
    let task_id = snapshot["taskId"].as_str().expect("task id").to_owned();

    let storage = state.storage.as_ref().expect("persistent storage");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let terminal = loop {
        if let Some(value) = storage.load_task(&task_id).expect("load task") {
            if matches!(
                value.state,
                pi_remote_control::protocol::RemoteTaskState::Succeeded
                    | pi_remote_control::protocol::RemoteTaskState::Failed
                    | pi_remote_control::protocol::RemoteTaskState::Cancelled
            ) {
                break value;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "runtime did not finish"
        );
        std::thread::sleep(Duration::from_millis(25));
    };
    assert_eq!(
        terminal.state,
        pi_remote_control::protocol::RemoteTaskState::Succeeded
    );
    assert!(terminal.finished_at.is_some());

    let events = storage.load_events(&device_id, None).expect("load events");
    assert!(events
        .iter()
        .any(|event| matches!(event.payload, RemoteEvent::TaskCreated { .. })));
    assert!(events.iter().any(|event| matches!(
        event.payload,
        RemoteEvent::TaskStateChanged {
            to: pi_remote_control::protocol::RemoteTaskState::Running,
            ..
        }
    )));
    assert!(events
        .iter()
        .any(|event| matches!(event.payload, RemoteEvent::TaskCompleted { .. })));
    assert!(events.iter().any(|event| matches!(
        event.payload,
        RemoteEvent::TaskOutputAppended { ref fragment, .. } if fragment.contains("stage7 output")
    )));
    state.supervisor.stop();
    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn restart_restores_terminal_tasks_and_cross_restart_idempotency() {
    let root =
        std::env::temp_dir().join(format!("ragcode-pi-stage7-restart-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("root");
    fs::write(root.join("main.rs"), "fn main() {}\n").expect("context file");
    let db = root.join("remote-control.sqlite3");
    let first_state = state(&db);
    let project = first_state
        .projects
        .allow_project(&root, "restart-project", None)
        .expect("project");
    let project_id = project.project_id.clone();
    let (device_id, token) = register(&first_state);
    first_state
        .storage
        .as_ref()
        .expect("persistent storage")
        .upsert_device(
            &first_state
                .devices
                .stored_device(&device_id)
                .expect("stored device"),
        )
        .expect("persist device");
    let request = RemoteTaskCreateRequest {
        request_id: "restart-request".into(),
        project_id,
        prompt: "persist across restart".into(),
        context_files: vec![RemoteTaskContextFile {
            relative_path: "main.rs".into(),
        }],
        execution_profile: None,
    };
    let response = build_router(first_state.clone())
        .oneshot(authenticated_request(
            "/api/v1/tasks",
            &device_id,
            &token,
            serde_json::to_vec(&request).expect("request json"),
        ))
        .await
        .expect("create response");
    assert_eq!(response.status(), StatusCode::OK);
    let created: serde_json::Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("create body"),
    )
    .expect("create json");
    let task_id = created["taskId"].as_str().expect("task id").to_owned();

    let storage = first_state.storage.as_ref().expect("persistent storage");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if storage
            .load_task(&task_id)
            .expect("load task")
            .is_some_and(|task| {
                matches!(
                    task.state,
                    pi_remote_control::protocol::RemoteTaskState::Succeeded
                        | pi_remote_control::protocol::RemoteTaskState::Failed
                        | pi_remote_control::protocol::RemoteTaskState::Cancelled
                )
            })
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "runtime did not finish"
        );
        std::thread::sleep(Duration::from_millis(25));
    }
    first_state.supervisor.stop();
    assert!(first_state.supervisor.wait_for_idle(Duration::from_secs(2)));
    drop(first_state);

    let restored = state(&db);
    restored
        .projects
        .restore_project(PersistedProject {
            project_id: request.project_id.clone(),
            root: root.clone(),
            name: "restart-project".into(),
            last_opened_at: None,
        })
        .expect("restore project");
    let router = build_router(restored.clone());
    let listed = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/v1/tasks")
                .header("x-pi-device-id", &device_id)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(listed.status(), StatusCode::OK);
    let listed: Vec<serde_json::Value> = serde_json::from_slice(
        &to_bytes(listed.into_body(), 64 * 1024)
            .await
            .expect("list body"),
    )
    .expect("list json");
    assert!(listed.iter().any(|task| task["taskId"] == task_id));

    let duplicate = router
        .oneshot(authenticated_request(
            "/api/v1/tasks",
            &device_id,
            &token,
            serde_json::to_vec(&request).expect("duplicate request json"),
        ))
        .await
        .expect("duplicate response");
    assert_eq!(duplicate.status(), StatusCode::OK);
    let duplicate: serde_json::Value = serde_json::from_slice(
        &to_bytes(duplicate.into_body(), 64 * 1024)
            .await
            .expect("duplicate body"),
    )
    .expect("duplicate json");
    assert_eq!(duplicate["taskId"], task_id);

    restored.supervisor.stop();
    let _ = fs::remove_dir_all(&root);
}
