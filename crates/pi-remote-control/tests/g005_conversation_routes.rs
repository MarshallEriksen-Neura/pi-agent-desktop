//! G005 v2 route gates: owner-scoped conversation surface, capability
//! fail-closed gating, idempotency, queue capacity, interaction-pending
//! blocking, cancel semantics, cross-device isolation, and v2 event replay.

use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use futures_util::StreamExt;
use pi_remote_control::conversation_runtime::{
    ConversationRuntimeConfig, ConversationRuntimeManager,
};
use pi_remote_control::device_store::DeviceRegistry;
use pi_remote_control::gateway::{build_router, GatewayState};
use pi_remote_control::identity::{create_initial_identity, InMemoryIdentityStore};
use pi_remote_control::pi_session::{PiSessionAdapter, PiSessionConfig, PiSessionContext};
use pi_remote_control::storage::TurnExecutionInput;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio_tungstenite::connect_async;
use tower::ServiceExt;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time")
        .as_millis() as u64
}

fn fixture_root(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("ragcode-pi-g005-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

struct RouteRig {
    root: PathBuf,
    router: axum::Router,
    state: GatewayState,
}

/// Builds the gateway with schema v3 storage and the probe-proven
/// conversation runtime (fixture Pi).
fn rig(name: &str) -> RouteRig {
    let root = fixture_root(name);
    let project_root = root.join("project");
    std::fs::create_dir_all(&project_root).unwrap();
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-1", vec!["localhost".to_owned()])
            .expect("create identity");
    let state = GatewayState::with_storage(
        identity,
        Arc::new(DeviceRegistry::new()),
        "test-server",
        root.join("gateway.db"),
    )
    .expect("open storage");
    let session_config = PiSessionConfig {
        stop_timeout: Duration::from_secs(2),
        rpc_timeout: Duration::from_secs(2),
        turn_timeout: Duration::from_secs(10),
        ..PiSessionConfig::new(
            PathBuf::from(env!("CARGO_BIN_EXE_fake_pi_session_fixture")).into_os_string(),
            root.join("private-sessions"),
        )
    };
    let summary = state
        .projects
        .allow_project(&project_root, "project", None)
        .expect("allow project");
    let probe_context = PiSessionContext {
        owner_device_id: "probe".into(),
        conversation_id: "probe".into(),
        project_id: summary.project_id,
        project_root,
    };
    let probe = PiSessionAdapter::probe(session_config.clone(), probe_context).expect("probe");
    let adapter = Arc::new(PiSessionAdapter::new(session_config, probe).expect("adapter"));
    let storage = state.storage.clone().expect("storage present");
    let manager = ConversationRuntimeManager::new(
        storage,
        Arc::clone(&state.projects),
        adapter,
        ConversationRuntimeConfig::default(),
    );
    let state = state.with_conversation_runtime(manager);
    let router = build_router(state.clone());
    RouteRig {
        root,
        router,
        state,
    }
}

/// Gateway without storage/runtime: v2 must stay fail-closed.
fn bare_rig(name: &str) -> RouteRig {
    let root = fixture_root(name);
    let identity_store = InMemoryIdentityStore::default();
    let identity =
        create_initial_identity(&identity_store, "desktop-1", vec!["localhost".to_owned()])
            .expect("create identity");
    let state = GatewayState::new(identity, Arc::new(DeviceRegistry::new()), "test-server");
    let router = build_router(state.clone());
    RouteRig {
        root,
        router,
        state,
    }
}

fn register_device(state: &GatewayState, device_id: &str) -> (String, String) {
    let registered = state
        .devices
        .register(
            pi_remote_control::protocol::PairingDeviceMetadata {
                device_id: device_id.to_owned(),
                display_name: device_id.to_owned(),
                platform: pi_remote_control::protocol::PairingDevicePlatform::Ios,
                app_version: None,
            },
            now_ms(),
        )
        .expect("register device");
    (registered.device_id, registered.token)
}

fn auth_request(
    method: Method,
    uri: &str,
    device_id: &str,
    token: &str,
    body: Value,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("x-pi-device-id", device_id)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).expect("json")))
        .expect("request")
}

fn websocket_request(url: &str, device_id: &str, token: &str) -> axum::http::Request<()> {
    let host = url
        .strip_prefix("ws://")
        .and_then(|value| value.split('/').next())
        .expect("websocket host");
    Request::builder()
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

async fn json_body(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    serde_json::from_slice(&bytes).expect("json body")
}

fn create_body(request_id: &str, project_id: &str, prompt: &str) -> Value {
    serde_json::json!({
        "requestId": request_id,
        "projectId": project_id,
        "prompt": prompt,
        "contextFiles": [],
    })
}

#[tokio::test]
async fn create_conversation_is_durable_idempotent_and_transcript_is_authoritative() {
    let rig = rig("create");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();
    let body = create_body("req-1", &project_id, "hello world");

    let response = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            body.clone(),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let value = json_body(response).await;
    let conversation_id = value["conversation"]["conversationId"]
        .as_str()
        .expect("conversationId")
        .to_owned();
    let turn_id = value["turn"]["turnId"].as_str().expect("turnId").to_owned();
    assert_eq!(value["turn"]["state"], "queued");
    assert_eq!(value["userMessage"]["text"], "hello world");
    assert_eq!(value["delivery"]["status"], "accepted");
    // No private session material leaks into any DTO.
    let serialized = value.to_string();
    assert!(!serialized.contains("relativeRef"));
    assert!(!serialized.contains("relative_ref"));
    assert!(!serialized.contains("private-sessions"));

    // Replayed create returns the same accepted message/turn, no redelivery.
    let replay = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            body,
        ))
        .await
        .expect("response");
    assert_eq!(replay.status(), StatusCode::OK);
    let replay_value = json_body(replay).await;
    assert_eq!(
        replay_value["conversation"]["conversationId"],
        conversation_id
    );
    assert_eq!(replay_value["turn"]["turnId"], turn_id);

    // Snapshot + paged transcript come from the server, not the phone.
    let snapshot = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            &format!("/api/v2/conversations/{conversation_id}"),
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(snapshot.status(), StatusCode::OK);
    let snapshot_value = json_body(snapshot).await;
    assert_eq!(snapshot_value["status"], "queued");
    assert_eq!(snapshot_value["messageCount"], 1);

    let page = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            &format!("/api/v2/conversations/{conversation_id}/messages"),
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(page.status(), StatusCode::OK);
    let page_value = json_body(page).await;
    assert_eq!(page_value["messages"][0]["text"], "hello world");
    assert_eq!(page_value["messages"][0]["role"], "user");

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn v2_routes_fail_closed_until_storage_and_runtime_are_wired() {
    let rig = bare_rig("gating");
    let (device, token) = register_device(&rig.state, "mobile-01");

    let capabilities = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/capabilities",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(capabilities.status(), StatusCode::SERVICE_UNAVAILABLE);

    let create = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-1", "project-x", "hi"),
        ))
        .await
        .expect("response");
    assert_eq!(create.status(), StatusCode::SERVICE_UNAVAILABLE);

    let stream = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/events/stream",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert!(matches!(
        stream.status(),
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::BAD_REQUEST
    ));

    // V1 surface keeps working regardless of v2 health.
    let v1 = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v1/capabilities",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(v1.status(), StatusCode::OK);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn wired_capabilities_advertise_conversation_v2_limits() {
    let rig = rig("capabilities");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let response = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/capabilities",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let value = json_body(response).await;
    assert_eq!(value["conversationV2"], true);
    assert_eq!(value["piSessionResume"], true);
    assert_eq!(value["maxQueuedTurns"], 8);
    assert_eq!(value["maxPromptBytes"], 32 * 1024);
    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn cross_device_access_is_indistinguishable_from_not_found() {
    let rig = rig("isolation");
    let (owner, owner_token) = register_device(&rig.state, "mobile-01");
    let (stranger, stranger_token) = register_device(&rig.state, "mobile-02");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &owner,
            &owner_token,
            create_body("req-1", &project_id, "private"),
        ))
        .await
        .expect("response");
    assert_eq!(created.status(), StatusCode::OK);
    let created_value = json_body(created).await;
    let conversation_id = created_value["conversation"]["conversationId"]
        .as_str()
        .expect("conversationId")
        .to_owned();
    let turn_id = created_value["turn"]["turnId"]
        .as_str()
        .expect("turnId")
        .to_owned();

    // Snapshot, transcript, append, cancel: all look like not found.
    for (method, uri, body) in [
        (
            Method::GET,
            format!("/api/v2/conversations/{conversation_id}"),
            Value::Null,
        ),
        (
            Method::GET,
            format!("/api/v2/conversations/{conversation_id}/messages"),
            Value::Null,
        ),
        (
            Method::POST,
            format!("/api/v2/conversations/{conversation_id}/turns"),
            serde_json::json!({"requestId": "req-x", "prompt": "intrude"}),
        ),
        (
            Method::POST,
            format!("/api/v2/turns/{turn_id}/cancel"),
            serde_json::json!({"requestId": "cancel-x"}),
        ),
    ] {
        let response = rig
            .router
            .clone()
            .oneshot(auth_request(method, &uri, &stranger, &stranger_token, body))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "uri {uri}");
    }

    // The stranger's list stays empty.
    let list = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/conversations",
            &stranger,
            &stranger_token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(list.status(), StatusCode::OK);
    let list_value = json_body(list).await;
    assert_eq!(list_value["conversations"].as_array().unwrap().len(), 0);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn append_enforces_idempotency_and_eight_turn_queue_capacity() {
    let rig = rig("queue-capacity");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-1", &project_id, "turn one"),
        ))
        .await
        .expect("response");
    assert_eq!(created.status(), StatusCode::OK);
    let created_value = json_body(created).await;
    let conversation_id = created_value["conversation"]["conversationId"]
        .as_str()
        .expect("conversationId")
        .to_owned();
    let append_uri = format!("/api/v2/conversations/{conversation_id}/turns");

    // Fill the queue: initial queued turn + seven appends = eight.
    for index in 2..=8 {
        let response = rig
            .router
            .clone()
            .oneshot(auth_request(
                Method::POST,
                &append_uri,
                &device,
                &token,
                serde_json::json!({"requestId": format!("req-{index}"), "prompt": format!("turn {index}")}),
            ))
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::OK, "append {index}");
        let value = json_body(response).await;
        assert_eq!(value["duplicate"], false);
    }

    // The ninth queued turn hits the capacity gate.
    let overflow = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &append_uri,
            &device,
            &token,
            serde_json::json!({"requestId": "req-9", "prompt": "turn nine"}),
        ))
        .await
        .expect("response");
    assert_eq!(overflow.status(), StatusCode::CONFLICT);
    let overflow_value = json_body(overflow).await;
    assert_eq!(overflow_value["code"], "queue_full");

    // A replayed append returns the original accepted turn, not an error.
    let replay = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &append_uri,
            &device,
            &token,
            serde_json::json!({"requestId": "req-2", "prompt": "turn 2"}),
        ))
        .await
        .expect("response");
    let replay_status = replay.status();
    let replay_value = json_body(replay).await;
    assert_eq!(replay_status, StatusCode::OK, "replay body: {replay_value}");
    assert_eq!(replay_value["duplicate"], true);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn append_is_blocked_while_a_turn_awaits_input() {
    let rig = rig("awaiting-input");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-1", &project_id, "turn one"),
        ))
        .await
        .expect("response");
    assert_eq!(created.status(), StatusCode::OK);
    let created_value = json_body(created).await;
    let conversation_id = created_value["conversation"]["conversationId"]
        .as_str()
        .expect("conversationId")
        .to_owned();
    let turn_id = created_value["turn"]["turnId"]
        .as_str()
        .expect("turnId")
        .to_owned();

    // Drive the turn into awaiting_input through the storage lifecycle.
    let storage = rig.state.storage.as_ref().expect("storage");
    storage
        .mark_turn_started(&TurnExecutionInput {
            owner_device_id: device.clone(),
            conversation_id: conversation_id.clone(),
            turn_id: turn_id.clone(),
            at_ms: now_ms(),
            at: "2026-08-12T00:00:03.000Z".into(),
            event_id: "g005-start".into(),
        })
        .expect("started");
    storage
        .mark_turn_running(&TurnExecutionInput {
            owner_device_id: device.clone(),
            conversation_id: conversation_id.clone(),
            turn_id: turn_id.clone(),
            at_ms: now_ms(),
            at: "2026-08-12T00:00:04.000Z".into(),
            event_id: "g005-running".into(),
        })
        .expect("running");
    storage
        .mark_turn_awaiting_input(&TurnExecutionInput {
            owner_device_id: device.clone(),
            conversation_id: conversation_id.clone(),
            turn_id: turn_id.clone(),
            at_ms: now_ms(),
            at: "2026-08-12T00:00:05.000Z".into(),
            event_id: "g005-await".into(),
        })
        .expect("awaiting");

    // Ordinary send is rejected with the stable interaction_pending conflict.
    let response = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &format!("/api/v2/conversations/{conversation_id}/turns"),
            &device,
            &token,
            serde_json::json!({"requestId": "req-2", "prompt": "interrupt"}),
        ))
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let value = json_body(response).await;
    assert_eq!(value["code"], "interaction_pending");

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn cancel_route_cancels_queued_turn_idempotently_and_rejects_unknown_turns() {
    let rig = rig("cancel-route");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-1", &project_id, "turn one"),
        ))
        .await
        .expect("response");
    let created_value = json_body(created).await;
    let conversation_id = created_value["conversation"]["conversationId"]
        .as_str()
        .expect("conversationId")
        .to_owned();
    let appended = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &format!("/api/v2/conversations/{conversation_id}/turns"),
            &device,
            &token,
            serde_json::json!({"requestId": "req-2", "prompt": "turn two"}),
        ))
        .await
        .expect("response");
    let appended_value = json_body(appended).await;
    let turn_id = appended_value["turn"]["turnId"]
        .as_str()
        .expect("turnId")
        .to_owned();

    // Cancel the queued turn.
    let cancel = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &format!("/api/v2/turns/{turn_id}/cancel"),
            &device,
            &token,
            serde_json::json!({"requestId": "cancel-1"}),
        ))
        .await
        .expect("response");
    assert_eq!(cancel.status(), StatusCode::OK);
    let cancel_value = json_body(cancel).await;
    assert_eq!(cancel_value["turn"]["state"], "cancelled");
    assert_eq!(cancel_value["duplicate"], false);

    // Repeating the cancel is idempotent: same state, flagged duplicate.
    let repeat = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            &format!("/api/v2/turns/{turn_id}/cancel"),
            &device,
            &token,
            serde_json::json!({"requestId": "cancel-2"}),
        ))
        .await
        .expect("response");
    assert_eq!(repeat.status(), StatusCode::OK);
    let repeat_value = json_body(repeat).await;
    assert_eq!(repeat_value["turn"]["state"], "cancelled");
    assert_eq!(repeat_value["duplicate"], true);

    // Unknown turns look like not found.
    let unknown = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/turns/turn-does-not-exist/cancel",
            &device,
            &token,
            serde_json::json!({"requestId": "cancel-3"}),
        ))
        .await
        .expect("response");
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn events_replay_serves_semantic_events_and_flags_cursor_gaps() {
    let rig = rig("events-replay");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-1", &project_id, "turn one"),
        ))
        .await
        .expect("response");
    assert_eq!(created.status(), StatusCode::OK);
    // A second conversation yields a second event so retention can leave a
    // non-empty tail with a real gap in front of it.
    let second = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-2", &project_id, "turn two"),
        ))
        .await
        .expect("response");
    assert_eq!(second.status(), StatusCode::OK);

    let replay = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/events",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    assert_eq!(replay.status(), StatusCode::OK);
    let replay_value = json_body(replay).await;
    let events = replay_value["events"].as_array().expect("events");
    assert!(!events.is_empty());
    assert_eq!(events[0]["kind"], "conversation.created");
    assert_eq!(events[0]["conversationId"].is_string(), true);
    assert_eq!(replay_value["snapshotRequired"], false);
    let last_cursor = replay_value["nextCursor"].as_str().expect("cursor");

    // Replaying from the last cursor yields nothing and no gap.
    let tail = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            &format!("/api/v2/events?after={last_cursor}"),
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    let tail_value = json_body(tail).await;
    assert_eq!(tail_value["events"].as_array().unwrap().len(), 0);
    assert_eq!(tail_value["snapshotRequired"], false);

    // Simulate retention: drop the oldest event; old cursors must now fall
    // back to snapshot reconciliation.
    let db = rig.root.join("gateway.db");
    let connection = rusqlite::Connection::open(&db).expect("open db");
    connection
        .execute(
            "DELETE FROM events WHERE sequence = (SELECT MIN(sequence) FROM events)",
            [],
        )
        .expect("delete oldest event");
    drop(connection);

    let gap_replay = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::GET,
            "/api/v2/events?after=0",
            &device,
            &token,
            Value::Null,
        ))
        .await
        .expect("response");
    let gap_value = json_body(gap_replay).await;
    assert_eq!(gap_value["snapshotRequired"], true);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn v2_event_stream_replays_durable_conversation_events() {
    let rig = rig("events-stream");
    let (device, token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();
    let created = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &device,
            &token,
            create_body("req-stream", &project_id, "stream me"),
        ))
        .await
        .expect("create response");
    assert_eq!(created.status(), StatusCode::OK);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind listener");
    let address = listener.local_addr().expect("listener address");
    let router = rig.router.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("v2 stream test server");
    });

    let url = format!("ws://{address}/api/v2/events/stream?after=0");
    let (mut socket, response) = connect_async(websocket_request(&url, &device, &token))
        .await
        .expect("v2 websocket connection");
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("event timeout")
        .expect("event frame")
        .expect("websocket frame");
    let text = match frame {
        tokio_tungstenite::tungstenite::Message::Text(text) => text,
        other => panic!("expected v2 text event, got {other:?}"),
    };
    let value: Value = serde_json::from_str(&text).expect("v2 event json");
    assert_eq!(value["kind"], "conversation.created");
    assert_eq!(value["conversationId"].is_string(), true);

    drop(socket);
    server.abort();
    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn archive_is_owner_scoped_and_diagnostics_are_redacted_counters_only() {
    let rig = rig("archive-diagnostics");
    let (owner, owner_token) = register_device(&rig.state, "mobile-01");
    let (other, other_token) = register_device(&rig.state, "mobile-02");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();
    let body = create_body("req-archive", &project_id, "private prompt must not appear");
    let created = rig
        .router
        .clone()
        .oneshot(auth_request(Method::POST, "/api/v2/conversations", &owner, &owner_token, body.clone()))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created_value = json_body(created).await;
    let conversation_id = created_value["conversation"]["conversationId"].as_str().unwrap().to_owned();
    let archive_uri = format!("/api/v2/conversations/{conversation_id}/archive");

    let stranger = rig
        .router
        .clone()
        .oneshot(auth_request(Method::POST, &archive_uri, &other, &other_token, serde_json::json!({"requestId":"archive-x"})))
        .await
        .unwrap();
    assert_eq!(stranger.status(), StatusCode::NOT_FOUND);

    let archived = rig
        .router
        .clone()
        .oneshot(auth_request(Method::POST, &archive_uri, &owner, &owner_token, serde_json::json!({"requestId":"archive-1"})))
        .await
        .unwrap();
    assert_eq!(archived.status(), StatusCode::OK);
    let archived_value = json_body(archived).await;
    assert_eq!(archived_value["conversation"]["status"], "archived");
    // The authoritative owner transcript remains available through the
    // owner-scoped messages route; archive response itself contains only the
    // snapshot and duplicate marker.
    assert!(archived_value["conversation"]["conversationId"].is_string());

    let append = rig
        .router
        .clone()
        .oneshot(auth_request(Method::POST, &format!("/api/v2/conversations/{conversation_id}/turns"), &owner, &owner_token, serde_json::json!({"requestId":"req-after-archive","prompt":"no"})))
        .await
        .unwrap();
    assert_eq!(append.status(), StatusCode::CONFLICT);

    let diagnostics = rig
        .router
        .clone()
        .oneshot(auth_request(Method::GET, "/api/v2/diagnostics", &owner, &owner_token, Value::Null))
        .await
        .unwrap();
    assert_eq!(diagnostics.status(), StatusCode::OK);
    let diagnostics_value = json_body(diagnostics).await;
    for key in [
        "activeConversations", "queuedTurns", "activeTurns", "resumeSuccess",
        "resumeFailure", "hostInterruptedTurns", "duplicateRequests", "droppedDeltas",
        "snapshotResyncs",
    ] {
        assert!(diagnostics_value.get(key).and_then(Value::as_u64).is_some(), "missing {key}");
    }
    let diagnostic_text = diagnostics_value.to_string();
    for secret in ["private prompt", "private-sessions", "sessionId", "absolutePath", "token"] {
        assert!(!diagnostic_text.contains(secret), "diagnostics leaked {secret}");
    }

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn model_admin_routes_require_elevated_scope_and_audit_operations() {
    let mut rig = rig("model-admin");
    let (owner, owner_token) = register_device(&rig.state, "mobile-01");
    let (admin, admin_token) = register_device(&rig.state, "mobile-02");

    // Wire a redacted host catalog so the routes are reachable.
    let models_dir = rig.root.join("models");
    std::fs::create_dir_all(&models_dir).unwrap();
    let models_json = models_dir.join("models.json");
    std::fs::write(
        &models_json,
        r#"{"providers": {"openai": {"baseUrl": "https://api.openai.com/v1", "api": "openai-responses", "apiKey": "sk-secret", "models": [{"id": "gpt-4.1", "name": "GPT-4.1"}]}}}"#,
    )
    .unwrap();
    let state = rig.state.with_models(
        pi_remote_control::models::HostModelCatalog::new(
            Some(models_json),
            String::new(),
            String::new(),
        )
        .map(Arc::new),
    );
    let router = build_router(state.clone());
    rig.state = state;
    rig.router = router;

    // Model catalog listing stays open to every paired device, redacted.
    let listing = rig
        .router
        .clone()
        .oneshot(auth_request(Method::GET, "/api/v2/models", &owner, &owner_token, Value::Null))
        .await
        .unwrap();
    assert_eq!(listing.status(), StatusCode::OK);
    let listing_value = json_body(listing).await;
    assert_eq!(listing_value["models"][0]["modelId"], "gpt-4.1");
    let listing_text = listing_value.to_string();
    assert!(!listing_text.contains("sk-secret"));
    assert!(!listing_text.contains("https://"));

    // discover/add/enable are elevated: a default pairing gets 403.
    for (uri, body) in [
        ("/api/v2/models/discover", serde_json::json!({"provider": "openai"})),
        ("/api/v2/models", serde_json::json!({"provider": "openai", "models": []})),
        ("/api/v2/models/openai%2Fgpt-4.1/remote-enable", serde_json::json!({"enabled": true})),
    ] {
        let denied = rig
            .router
            .clone()
            .oneshot(auth_request(Method::POST, uri, &owner, &owner_token, body))
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN, "{uri}");
    }

    // Granting model-admin to a device enables the routes; the grant is
    // durable and the audit trail records the operations.
    rig.state
        .devices
        .set_model_admin(&admin, true)
        .expect("grant");
    rig.state
        .storage
        .as_ref()
        .unwrap()
        .set_model_admin_grant(&admin, true, now_ms())
        .expect("persist grant");

    let discovered = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/models/discover",
            &admin,
            &admin_token,
            serde_json::json!({"provider": "openai"}),
        ))
        .await
        .unwrap();
    assert_eq!(discovered.status(), StatusCode::OK);
    let discovered_value = json_body(discovered).await;
    assert_eq!(discovered_value["candidates"][0]["modelId"], "gpt-4.1");

    let enabled = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/models/openai%2Fgpt-4.1/remote-enable",
            &admin,
            &admin_token,
            serde_json::json!({"enabled": true}),
        ))
        .await
        .unwrap();
    assert_eq!(enabled.status(), StatusCode::OK);
    let enabled_value = json_body(enabled).await;
    assert!(enabled_value["remoteAllowed"].as_bool().unwrap());

    // The audit table recorded both operations.
    let connection = rusqlite::Connection::open(rig.root.join("gateway.db")).unwrap();
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM model_admin_audit WHERE device_id=?1",
            [&admin],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);

    // Revocation flips the routes back to forbidden for the same device.
    rig.state
        .devices
        .set_model_admin(&admin, false)
        .expect("revoke");
    let denied = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/models/discover",
            &admin,
            &admin_token,
            serde_json::json!({"provider": "openai"}),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    let _ = std::fs::remove_dir_all(rig.root);
}

#[tokio::test]
async fn model_ref_on_create_requires_remote_allowed_model_or_fails_clean() {
    let rig = rig("model-ref-gate");
    let (owner, owner_token) = register_device(&rig.state, "mobile-01");
    let project_id = rig.state.projects.list_projects()[0].project_id.clone();

    // No catalog wired: explicit modelRef fails closed with a 503 while the
    // same request without a modelRef still creates the conversation.
    let without_model = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &owner,
            &owner_token,
            create_body("req-nomodel", &project_id, "hello"),
        ))
        .await
        .unwrap();
    assert_eq!(without_model.status(), StatusCode::OK);

    let with_model = rig
        .router
        .clone()
        .oneshot(auth_request(
            Method::POST,
            "/api/v2/conversations",
            &owner,
            &owner_token,
            serde_json::json!({
                "requestId": "req-model",
                "projectId": project_id,
                "prompt": "hello with model",
                "contextFiles": [],
                "modelRef": "openai/gpt-4.1",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(with_model.status(), StatusCode::SERVICE_UNAVAILABLE);

    let _ = std::fs::remove_dir_all(rig.root);
}
