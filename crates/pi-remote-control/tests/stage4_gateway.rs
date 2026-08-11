use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use futures_util::StreamExt;
use pi_remote_control::config::RemoteControlConfig;
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::event_hub::EventPayload;
use pi_remote_control::gateway::{
    build_router, build_server_config, tls_identity_is_usable, GatewayServer, GatewayServerError,
    GatewayState,
};
use pi_remote_control::identity::{create_initial_identity, InMemoryIdentityStore};
use pi_remote_control::protocol::RemoteTaskContextFile;
use pi_remote_control::protocol::{
    CertificatePin, PairingDesktopIdentity, PairingDeviceMetadata, PairingDevicePlatform,
    PairingRequest, PairingSuccess, RemoteEndpoint, RemoteEndpointScheme, RemoteTaskCreateRequest,
};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_millis() as u64
}

fn state() -> GatewayState {
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-1", vec!["localhost".to_owned()])
            .expect("create identity");
    GatewayState::new(identity, Arc::new(DeviceRegistry::new()), "test-server")
}

fn pair_request(pairing_id: String, secret: String) -> PairingRequest {
    PairingRequest {
        version: 1,
        pairing_id,
        secret,
        device: PairingDeviceMetadata {
            device_id: "mobile-client".to_owned(),
            display_name: "Test phone".to_owned(),
            platform: PairingDevicePlatform::Ios,
            app_version: Some("1.0.0".to_owned()),
        },
    }
}

fn auth_device(state: &GatewayState, device_id: &str) -> (String, String) {
    let registered = state
        .devices
        .register(
            PairingDeviceMetadata {
                device_id: device_id.to_owned(),
                display_name: device_id.to_owned(),
                platform: PairingDevicePlatform::Ios,
                app_version: None,
            },
            now_ms(),
        )
        .expect("register test device");
    (registered.device_id, registered.token)
}

fn authenticated_request(
    method: Method,
    uri: &str,
    device_id: &str,
    token: &str,
    body: Body,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("x-pi-device-id", device_id)
        .header("authorization", format!("Bearer {token}"))
        .body(body)
        .expect("authenticated request")
}

fn websocket_request(url: &str, device_id: &str, token: &str) -> axum::http::Request<()> {
    let host = url
        .strip_prefix("ws://")
        .and_then(|value| value.split('/').next())
        .expect("websocket host");
    axum::http::Request::builder()
        .uri(url)
        .header("host", host)
        .header("x-pi-device-id", device_id)
        .header("authorization", format!("Bearer {token}"))
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .expect("websocket request")
}

#[tokio::test]
async fn gateway_rejects_unauthenticated_requests_and_authenticates_pairing_result() {
    let state = state();
    let payload = state
        .pairing
        .issue_ticket(
            PairingDesktopIdentity {
                desktop_id: "desktop-1".to_owned(),
                display_name: "Test desktop".to_owned(),
            },
            vec![RemoteEndpoint {
                scheme: RemoteEndpointScheme::Https,
                host: "192.168.1.20".to_owned(),
                port: 44321,
            }],
            CertificatePin {
                algorithm: "spki-sha256".to_owned(),
                value: "a".repeat(64),
            },
            None,
            now_ms(),
        )
        .expect("issue ticket");
    let router = build_router(state);

    let unauthenticated = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/v1/capabilities")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

    let pairing_body = serde_json::to_vec(&pair_request(payload.pairing_id, payload.secret))
        .expect("pairing JSON");
    let paired = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/pair")
                .header("x-request-id", "pair-1")
                .header("content-type", "application/json")
                .body(Body::from(pairing_body))
                .expect("pair request"),
        )
        .await
        .expect("pair response");
    assert_eq!(paired.status(), StatusCode::OK);
    let success: PairingSuccess = serde_json::from_slice(
        &to_bytes(paired.into_body(), 64 * 1024)
            .await
            .expect("pair response body"),
    )
    .expect("pairing success");

    let me = router
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/v1/me")
                .header("x-pi-device-id", &success.device_id)
                .header("authorization", format!("Bearer {}", success.token))
                .body(Body::empty())
                .expect("authenticated request"),
        )
        .await
        .expect("authenticated response");
    assert_eq!(me.status(), StatusCode::OK);
    let body = to_bytes(me.into_body(), 64 * 1024).await.expect("me body");
    let value: serde_json::Value = serde_json::from_slice(&body).expect("me JSON");
    assert_eq!(value["deviceId"], success.device_id);
    assert!(value.get("token").is_none());
}

#[tokio::test]
async fn gateway_enforces_body_limit_before_pairing_domain_execution() {
    let router = build_router(state());
    let response = router
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/pair")
                .header("x-request-id", "oversized-1")
                .body(Body::from(vec![0_u8; 64 * 1024 + 1]))
                .expect("oversized request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body: serde_json::Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("oversized response body"),
    )
    .expect("stable oversized response JSON");
    assert_eq!(body["code"], "payload_too_large");
    assert_eq!(body["requestId"], "oversized-1");
}

#[tokio::test]
async fn gateway_wires_project_and_task_routes_with_owner_isolation() {
    let state = state();
    let temp = tempfile::tempdir().expect("temp project");
    std::fs::create_dir(temp.path().join("src")).expect("source directory");
    std::fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").expect("source file");
    let project = state
        .projects
        .allow_project(temp.path(), "fixture-project", None)
        .expect("allow project");
    let (device_id, token) = auth_device(&state, "mobile-one");
    let (other_device_id, other_token) = auth_device(&state, "mobile-two");
    let router = build_router(state.clone());

    let projects = router
        .clone()
        .oneshot(authenticated_request(
            Method::GET,
            "/api/v1/projects",
            &device_id,
            &token,
            Body::empty(),
        ))
        .await
        .expect("projects response");
    assert_eq!(projects.status(), StatusCode::OK);
    let projects_body = to_bytes(projects.into_body(), 64 * 1024)
        .await
        .expect("projects body");
    let summaries: Vec<serde_json::Value> =
        serde_json::from_slice(&projects_body).expect("projects JSON");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0]["projectId"], project.project_id);
    assert!(summaries[0].get("root").is_none());

    let tree = router
        .clone()
        .oneshot(authenticated_request(
            Method::GET,
            &format!("/api/v1/projects/{}/tree?dir=src", project.project_id),
            &device_id,
            &token,
            Body::empty(),
        ))
        .await
        .expect("tree response");
    assert_eq!(tree.status(), StatusCode::OK);
    let tree_body = to_bytes(tree.into_body(), 64 * 1024)
        .await
        .expect("tree body");
    let tree_json: serde_json::Value = serde_json::from_slice(&tree_body).expect("tree JSON");
    assert_eq!(tree_json["entries"][0]["relativePath"], "src/main.rs");

    let create = RemoteTaskCreateRequest {
        request_id: "request-1".to_owned(),
        project_id: project.project_id.clone(),
        prompt: "run the fixture task".to_owned(),
        context_files: vec![RemoteTaskContextFile {
            relative_path: "src/main.rs".to_owned(),
        }],
        execution_profile: None,
    };
    let created = router
        .clone()
        .oneshot(authenticated_request(
            Method::POST,
            "/api/v1/tasks",
            &device_id,
            &token,
            Body::from(serde_json::to_vec(&create).expect("task JSON")),
        ))
        .await
        .expect("create response");
    assert_eq!(created.status(), StatusCode::OK);
    let created_snapshot: serde_json::Value = serde_json::from_slice(
        &to_bytes(created.into_body(), 64 * 1024)
            .await
            .expect("created body"),
    )
    .expect("created JSON");
    let task_id = created_snapshot["taskId"]
        .as_str()
        .expect("task ID")
        .to_owned();
    assert_eq!(created_snapshot["state"], "queued");

    let listed = router
        .clone()
        .oneshot(authenticated_request(
            Method::GET,
            "/api/v1/tasks",
            &device_id,
            &token,
            Body::empty(),
        ))
        .await
        .expect("list response");
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_json: serde_json::Value = serde_json::from_slice(
        &to_bytes(listed.into_body(), 64 * 1024)
            .await
            .expect("list body"),
    )
    .expect("list JSON");
    assert_eq!(listed_json.as_array().expect("task list").len(), 1);

    let foreign_detail = router
        .clone()
        .oneshot(authenticated_request(
            Method::GET,
            &format!("/api/v1/tasks/{task_id}"),
            &other_device_id,
            &other_token,
            Body::empty(),
        ))
        .await
        .expect("foreign detail response");
    assert_eq!(foreign_detail.status(), StatusCode::NOT_FOUND);

    let cancelled = router
        .oneshot(authenticated_request(
            Method::POST,
            &format!("/api/v1/tasks/{task_id}/cancel"),
            &device_id,
            &token,
            Body::empty(),
        ))
        .await
        .expect("cancel response");
    assert_eq!(cancelled.status(), StatusCode::OK);
    let cancelled_json: serde_json::Value = serde_json::from_slice(
        &to_bytes(cancelled.into_body(), 64 * 1024)
            .await
            .expect("cancel body"),
    )
    .expect("cancel JSON");
    assert_eq!(cancelled_json["state"], "cancelled");
}

#[tokio::test]
async fn websocket_route_authenticates_and_enforces_per_device_limit() {
    let state = state();
    let (device_id, token) = auth_device(&state, "mobile-ws");
    state.event_hub.publish(
        &device_id,
        "2026-01-01T00:00:00.000Z",
        EventPayload::TaskChanges {
            task_id: "task-replay".to_owned(),
            revision: 1,
        },
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind test listener");
    let address = listener.local_addr().expect("listener address");
    let server = tokio::spawn(async move {
        axum::serve(listener, build_router(state))
            .await
            .expect("gateway test server");
    });
    let url = format!("ws://{address}/api/v1/events?after=0");
    let (mut first, first_response) = connect_async(websocket_request(&url, &device_id, &token))
        .await
        .expect("first websocket connection");
    assert_eq!(first_response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let replayed = first
        .next()
        .await
        .expect("replayed event")
        .expect("replayed websocket message");
    let replayed_text = match replayed {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        other => panic!("expected replayed text event, got {other:?}"),
    };
    let replayed_json: serde_json::Value =
        serde_json::from_str(&replayed_text).expect("replayed event JSON");
    assert_eq!(replayed_json["kind"], "task.changes");
    assert_eq!(replayed_json["sequence"], 1);
    let (second, second_response) = connect_async(websocket_request(&url, &device_id, &token))
        .await
        .expect("second websocket connection");
    assert_eq!(second_response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let third = connect_async(websocket_request(&url, &device_id, &token))
        .await
        .expect_err("third websocket must be rate limited");
    assert!(third.to_string().contains("429"));
    drop(first);
    drop(second);
    server.abort();
}

#[test]
fn gateway_builds_tls_config_from_pinned_identity() {
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-1", vec!["localhost".to_owned()])
            .expect("create identity");
    assert!(tls_identity_is_usable(&identity));
    assert!(build_server_config(&identity).is_ok());
}

#[tokio::test]
async fn gateway_server_is_fail_closed_when_disabled() {
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-1", vec!["localhost".to_owned()])
            .expect("create identity");
    let tls = build_server_config(&identity).expect("TLS config");
    let result =
        GatewayServer::start(&RemoteControlConfig::default(), build_router(state()), tls).await;
    assert!(matches!(result, Err(GatewayServerError::Disabled)));
}
