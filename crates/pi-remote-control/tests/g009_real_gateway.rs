//! G009 explicit local smoke: real gateway routes plus the installed Pi CLI.
//!
//! This is intentionally ignored by default. It requires an explicitly chosen
//! Pi runtime and a configured provider, and it uses only a temporary project,
//! database, and private-session root.

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use pi_remote_control::conversation_runtime::{
    ConversationRuntimeConfig, ConversationRuntimeManager, DispatchOutcome,
};
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::gateway::{build_router, GatewayState};
use pi_remote_control::identity::{create_initial_identity, InMemoryIdentityStore};
use pi_remote_control::pi_session::{PiSessionAdapter, PiSessionConfig, PiSessionContext};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

fn root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "ragcode-pi-g009-real-gateway-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn auth_request(method: Method, uri: &str, device: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("x-pi-device-id", device)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn register(state: &GatewayState) -> (String, String) {
    let device = state
        .devices
        .register(
            pi_remote_control::protocol::PairingDeviceMetadata {
                device_id: "g009-mobile".into(),
                display_name: "g009-mobile".into(),
                platform: pi_remote_control::protocol::PairingDevicePlatform::Android,
                app_version: None,
            },
            1,
        )
        .unwrap();
    (device.device_id, device.token)
}

fn build_real_gateway(
    root: &std::path::Path,
) -> (
    Router,
    GatewayState,
    Arc<ConversationRuntimeManager>,
) {
    let identity_store = InMemoryIdentityStore::default();
    let identity = create_initial_identity(&identity_store, "g009-desktop", vec!["localhost".into()]).unwrap();
    let state = GatewayState::with_storage(
        identity,
        Arc::new(DeviceRegistry::new()),
        "g009-real",
        root.join("gateway.db"),
    )
    .unwrap();
    let project_root = root.join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    let project = state.projects.allow_project(&project_root, "g009", None).unwrap();
    let node = std::env::var_os("RAGCODE_REAL_PI_NODE").unwrap_or_else(|| "bun".into());
    let cli = std::env::var_os("RAGCODE_REAL_PI_CLI").expect("RAGCODE_REAL_PI_CLI is required");
    let config = PiSessionConfig {
        rpc_timeout: Duration::from_secs(30),
        turn_timeout: Duration::from_secs(300),
        stop_timeout: Duration::from_secs(5),
        ..PiSessionConfig::new(node, root.join("private-sessions")).with_prefix_args([cli])
    };
    let probe_context = PiSessionContext {
        owner_device_id: "g009-probe".into(),
        conversation_id: "g009-probe".into(),
        project_id: project.project_id,
        project_root,
    };
    let probe = PiSessionAdapter::probe(config.clone(), probe_context).unwrap();
    let adapter = Arc::new(PiSessionAdapter::new(config, probe).unwrap());
    let manager = ConversationRuntimeManager::new(
        state.storage.clone().unwrap(),
        Arc::clone(&state.projects),
        Arc::clone(&adapter),
        ConversationRuntimeConfig::default(),
    );
    let state = state.with_conversation_runtime(Arc::clone(&manager));
    (build_router(state.clone()), state, manager)
}

#[tokio::test]
#[ignore = "requires explicit real Pi CLI/provider configuration"]
async fn real_gateway_completes_two_turns_across_cold_resume() {
    let root = root();
    let (router, state, manager) = build_real_gateway(&root);
    let (device, token) = register(&state);
    let project_id = state.projects.list_projects()[0].project_id.clone();
    let project_root = root.join("project");
    let desktop_config = PiSessionConfig {
        rpc_timeout: Duration::from_secs(30),
        turn_timeout: Duration::from_secs(300),
        stop_timeout: Duration::from_secs(5),
        ..PiSessionConfig::new(
            std::env::var_os("RAGCODE_REAL_PI_NODE").unwrap_or_else(|| "bun".into()),
            root.join("desktop-sessions"),
        )
        .with_prefix_args([
            std::env::var_os("RAGCODE_REAL_PI_CLI").expect("RAGCODE_REAL_PI_CLI is required"),
        ])
    };
    let desktop_context = PiSessionContext {
        owner_device_id: "g009-desktop-owner".into(),
        conversation_id: "g009-desktop-chat".into(),
        project_id: project_id.clone(),
        project_root,
    };
    let desktop_probe = PiSessionAdapter::probe(desktop_config.clone(), desktop_context.clone())
        .expect("desktop Pi compatibility probe must pass");
    let desktop_adapter = PiSessionAdapter::new(desktop_config, desktop_probe)
        .expect("desktop Pi adapter must be constructible");
    let mut desktop_before = desktop_adapter
        .start(desktop_context.clone())
        .expect("desktop Pi session must start before remote turns");
    let desktop_before_outcome = desktop_before
        .run_turn("Reply with a short desktop chat acknowledgement.")
        .expect("desktop Pi turn before remote turns must settle");
    assert!(desktop_before_outcome.agent_end);
    let desktop_binding = desktop_before
        .state()
        .expect("desktop session state after first turn")
        .binding
        .clone();
    desktop_before
        .shutdown()
        .expect("desktop Pi session must stop before remote turns");
    let marker = "G009_REAL_GATEWAY_MARKER";

    let first = router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            serde_json::json!({
                "requestId": "g009-first",
                "projectId": project_id,
                "prompt": format!("Remember this marker exactly: {marker}. Reply with ACK."),
                "contextFiles": []
            }),
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first_value = json_body(first).await;
    let conversation_id = first_value["conversation"]["conversationId"].as_str().unwrap().to_owned();
    let first_outcome = manager.dispatch_next();
    assert!(
        matches!(first_outcome, DispatchOutcome::Completed { .. }),
        "first real turn outcome: {first_outcome:?}"
    );
    manager.stop();

    let second = router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &format!("/api/v2/conversations/{conversation_id}/turns"),
            &device,
            &token,
            serde_json::json!({
                "requestId": "g009-second",
                "prompt": "What exact marker did I ask you to remember? Reply with the marker only."
            }),
        ))
        .await
        .unwrap();
    assert_eq!(second.status(), StatusCode::OK);
    let second_outcome = manager.dispatch_next();
    assert!(
        matches!(second_outcome, DispatchOutcome::Completed { .. }),
        "second real turn outcome: {second_outcome:?}"
    );

    let page = state
        .storage
        .as_ref()
        .unwrap()
        .load_conversation_messages(&device, &conversation_id, None, 100)
        .unwrap()
        .unwrap();
    let assistant_text = page
        .messages
        .iter()
        .filter(|message| message.role == pi_remote_control::conversation_protocol::RemoteMessageRole::Assistant)
        .map(|message| message.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(assistant_text.contains(marker), "second real turn did not retain first-turn context");
    let mut desktop_after = desktop_adapter
        .resume(desktop_context, &desktop_binding)
        .expect("desktop Pi session must resume after remote turns");
    let desktop_after_outcome = desktop_after
        .run_turn("Reply with a second short desktop chat acknowledgement.")
        .expect("desktop Pi turn after remote turns must settle");
    assert!(desktop_after_outcome.agent_end);
    desktop_after
        .shutdown()
        .expect("desktop Pi session must stop after the boundary check");
    let _ = std::fs::remove_dir_all(root);
}
