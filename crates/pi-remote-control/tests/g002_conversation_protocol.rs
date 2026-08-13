use std::fmt::Debug;

use pi_remote_control::conversation_protocol::{
    can_transition_remote_turn, derive_remote_conversation_status,
    derive_remote_conversation_status_with_availability, event_base,
    validate_event_bounds, RemoteConversationCreateRequest, RemoteConversationError,
    RemoteConversationErrorCode, RemoteConversationEvent, RemoteConversationEventBase,
    RemoteConversationListResponse, RemoteConversationSnapshot, RemoteConversationStatus,
    RemoteMessageDeltaEvent, RemoteMessagePageResponse, RemoteToolStartedEvent,
    RemoteTurnAppendResponse, RemoteTurnSnapshot, RemoteTurnState,
    REMOTE_CONVERSATION_MAX_CONTEXT_FILES, REMOTE_CONVERSATION_MAX_DELTA_BYTES,
    REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES, REMOTE_CONVERSATION_MAX_PROMPT_BYTES,
    REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES,
};
use pi_remote_control::protocol::ValidationError;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

#[test]
fn v2_shared_fixtures_round_trip_through_rust_serde() {
    assert_round_trip::<RemoteConversationCreateRequest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/conversations/create-request.json"
    ));
    assert_round_trip::<RemoteConversationSnapshot>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/conversations/snapshot.json"
    ));
    assert_round_trip::<RemoteConversationListResponse>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/conversations/list-page.json"
    ));
    assert_round_trip::<RemoteTurnAppendResponse>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/turns/queued-append-response.json"
    ));
    assert_round_trip::<RemoteMessagePageResponse>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/messages/transcript-page.json"
    ));
    assert_round_trip::<Vec<RemoteConversationEvent>>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/events/all-kinds.json"
    ));
}

#[test]
fn v2_event_fixture_covers_all_semantic_event_kinds() {
    let events: Vec<RemoteConversationEvent> = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/events/all-kinds.json"
    ))
    .expect("events fixture must parse");
    let kinds = events
        .iter()
        .map(|event| {
            validate_event_bounds(event).expect("fixture event stays within v2 bounds");
            event_kind(event)
        })
        .collect::<Vec<_>>();

    assert_eq!(
        kinds,
        vec![
            "conversation.created",
            "conversation.status_changed",
            "turn.created",
            "turn.state_changed",
            "message.accepted",
            "message.delta",
            "tool.started",
            "tool.completed",
            "interaction.requested",
            "interaction.resolved",
            "interaction.expired",
            "message.completed",
            "turn.completed",
            "snapshot_required",
        ]
    );
    assert!(events
        .windows(2)
        .all(|pair| event_base(&pair[0]).sequence < event_base(&pair[1]).sequence));
}

#[test]
fn turn_transition_matrix_matches_v2_contract() {
    use RemoteTurnState::*;
    let states = [
        Queued,
        Starting,
        Running,
        AwaitingInput,
        Succeeded,
        Failed,
        Cancelled,
    ];
    let allowed = [
        (Queued, Starting),
        (Queued, Cancelled),
        (Queued, Failed),
        (Starting, Running),
        (Starting, Cancelled),
        (Starting, Failed),
        (Running, AwaitingInput),
        (Running, Succeeded),
        (Running, Failed),
        (Running, Cancelled),
        (AwaitingInput, Running),
        (AwaitingInput, Cancelled),
        (AwaitingInput, Failed),
    ];

    for from in &states {
        for to in &states {
            let expected = allowed.contains(&(from.clone(), to.clone()));
            assert_eq!(
                can_transition_remote_turn(from, to),
                expected,
                "transition {from:?} -> {to:?}"
            );
        }
    }
}

#[test]
fn derived_conversation_status_keeps_terminal_turn_appendable() {
    let mut turn = turn(RemoteTurnState::Succeeded, None);
    assert_eq!(
        derive_remote_conversation_status(None, None, Some(&turn)),
        RemoteConversationStatus::Idle
    );
    assert_eq!(
        derive_remote_conversation_status(Some("2026-08-12T09:00:00.000Z"), None, Some(&turn)),
        RemoteConversationStatus::Archived
    );
    turn.state = RemoteTurnState::Failed;
    turn.error = Some(RemoteConversationError {
        code: RemoteConversationErrorCode::HostInterrupted,
        message: "desktop restarted".to_owned(),
        retryable: true,
    });
    assert_eq!(
        derive_remote_conversation_status(None, None, Some(&turn)),
        RemoteConversationStatus::Interrupted
    );
    turn.state = RemoteTurnState::AwaitingInput;
    turn.error = None;
    assert_eq!(
        derive_remote_conversation_status(None, Some(&turn), None),
        RemoteConversationStatus::AwaitingInput
    );
    assert_eq!(
        derive_remote_conversation_status_with_availability(None, false, None, Some(&turn)),
        RemoteConversationStatus::Unavailable
    );
    assert_eq!(
        derive_remote_conversation_status_with_availability(
            Some("2026-08-12T09:00:00.000Z"),
            false,
            None,
            Some(&turn),
        ),
        RemoteConversationStatus::Archived
    );
}

#[test]
fn validators_enforce_v2_bounds_and_relative_context_only() {
    let mut create: RemoteConversationCreateRequest = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/conversations/create-request.json"
    ))
    .expect("create fixture parses");
    create.validate().expect("fixture is valid");

    create.prompt = "x".repeat(REMOTE_CONVERSATION_MAX_PROMPT_BYTES + 1);
    assert!(matches!(
        create.validate(),
        Err(ValidationError::TooLong {
            field: "prompt",
            ..
        })
    ));
    create.prompt = "ok".to_owned();
    create.context_files = (0..=REMOTE_CONVERSATION_MAX_CONTEXT_FILES)
        .map(
            |index| pi_remote_control::conversation_protocol::RemoteConversationContextFile {
                relative_path: format!("file-{index}.txt"),
            },
        )
        .collect();
    assert!(matches!(
        create.validate(),
        Err(ValidationError::TooMany {
            field: "contextFiles",
            ..
        })
    ));
    create.context_files = vec![
        pi_remote_control::conversation_protocol::RemoteConversationContextFile {
            relative_path: "C:/Users/timeline/secret.txt".to_owned(),
        },
    ];
    assert!(matches!(
        create.validate(),
        Err(ValidationError::InvalidValue {
            field: "relativePath"
        })
    ));

    let oversized_delta = RemoteConversationEvent::MessageDelta(RemoteMessageDeltaEvent {
        base: event_base_value(),
        turn_id: "turn".to_owned(),
        message_id: "msg".to_owned(),
        delta: "x".repeat(REMOTE_CONVERSATION_MAX_DELTA_BYTES + 1),
    });
    assert!(matches!(
        validate_event_bounds(&oversized_delta),
        Err(ValidationError::TooLong { field: "delta", .. })
    ));

    let oversized_tool = RemoteConversationEvent::ToolStarted(RemoteToolStartedEvent {
        base: event_base_value(),
        turn_id: "turn".to_owned(),
        tool_call_id: "tool".to_owned(),
        name: "shell".to_owned(),
        summary: Some("x".repeat(REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES + 1)),
    });
    assert!(matches!(
        validate_event_bounds(&oversized_tool),
        Err(ValidationError::TooLong {
            field: "summary",
            ..
        })
    ));
}

#[test]
fn private_runtime_fields_are_not_accepted_or_serialized() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/adversarial/rejected-private-fields.json"
    ))
    .expect("adversarial fixture must parse");
    let payload = manifest
        .get("payload")
        .expect("fixture must include a payload")
        .clone();
    assert!(
        serde_json::from_value::<RemoteConversationSnapshot>(payload).is_err(),
        "deny_unknown_fields rejects private session/raw RPC fields"
    );

    let snapshot: RemoteConversationSnapshot = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/conversations/snapshot.json"
    ))
    .expect("snapshot fixture parses");
    let serialized = serde_json::to_value(snapshot).expect("snapshot serializes");
    let forbidden = manifest
        .get("forbiddenFields")
        .and_then(Value::as_array)
        .expect("fixture must include forbidden fields");
    for field in forbidden {
        let field = field.as_str().expect("forbidden field must be a string");
        assert!(
            !contains_key_recursive(&serialized, field),
            "leaked {field}"
        );
    }

    let mut event_with_private_field: Value = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/events/all-kinds.json"
    ))
    .expect("events fixture parses");
    event_with_private_field[0]["piSessionId"] = Value::String("private-session-id".to_owned());
    assert!(
        serde_json::from_value::<Vec<RemoteConversationEvent>>(event_with_private_field).is_err(),
        "event union rejects private fields on semantic events"
    );
}

#[test]
fn message_text_bound_is_explicit() {
    let mut page: RemoteMessagePageResponse = serde_json::from_str(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v2/messages/transcript-page.json"
    ))
    .expect("message page fixture parses");
    for message in &page.messages {
        message.validate().expect("fixture message is valid");
    }
    page.messages[0].text = "x".repeat(REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES + 1);
    assert!(matches!(
        page.messages[0].validate(),
        Err(ValidationError::TooLong { field: "text", .. })
    ));
}

fn assert_round_trip<T>(json: &str)
where
    T: DeserializeOwned + Serialize + Debug,
{
    let original: Value = serde_json::from_str(json).expect("fixture must be valid JSON");
    let decoded: T = serde_json::from_value(original.clone()).expect("fixture must match Rust DTO");
    let encoded = serde_json::to_value(decoded).expect("Rust DTO must serialize");
    assert_eq!(encoded, original, "fixture changed during serde round-trip");
}

fn event_kind(event: &RemoteConversationEvent) -> &'static str {
    match event {
        RemoteConversationEvent::ConversationCreated(_) => "conversation.created",
        RemoteConversationEvent::ConversationStatusChanged(_) => "conversation.status_changed",
        RemoteConversationEvent::TurnCreated(_) => "turn.created",
        RemoteConversationEvent::TurnStateChanged(_) => "turn.state_changed",
        RemoteConversationEvent::TurnCompleted(_) => "turn.completed",
        RemoteConversationEvent::MessageAccepted(_) => "message.accepted",
        RemoteConversationEvent::MessageDelta(_) => "message.delta",
        RemoteConversationEvent::MessageCompleted(_) => "message.completed",
        RemoteConversationEvent::ToolStarted(_) => "tool.started",
        RemoteConversationEvent::ToolCompleted(_) => "tool.completed",
        RemoteConversationEvent::InteractionRequested(_) => "interaction.requested",
        RemoteConversationEvent::InteractionResolved(_) => "interaction.resolved",
        RemoteConversationEvent::InteractionExpired(_) => "interaction.expired",
        RemoteConversationEvent::SnapshotRequired(_) => "snapshot_required",
    }
}

fn turn(state: RemoteTurnState, error: Option<RemoteConversationError>) -> RemoteTurnSnapshot {
    RemoteTurnSnapshot {
        turn_id: "turn".to_owned(),
        conversation_id: "conversation".to_owned(),
        request_id: "request".to_owned(),
        owner_device_id: "device".to_owned(),
        state,
        created_at: "2026-08-12T08:00:00.000Z".to_owned(),
        updated_at: "2026-08-12T08:00:00.000Z".to_owned(),
        started_at: None,
        finished_at: None,
        user_message_id: "msg_user".to_owned(),
        assistant_message_id: None,
        pending_interaction_id: None,
        delivery: None,
        error,
    }
}

fn event_base_value() -> RemoteConversationEventBase {
    RemoteConversationEventBase {
        event_id: "event".to_owned(),
        emitted_at: "2026-08-12T08:00:00.000Z".to_owned(),
        sequence: 1,
        device_id: "device".to_owned(),
        conversation_id: "conversation".to_owned(),
    }
}

fn contains_key_recursive(value: &Value, key: &str) -> bool {
    match value {
        Value::Object(map) => map
            .iter()
            .any(|(candidate, nested)| candidate == key || contains_key_recursive(nested, key)),
        Value::Array(items) => items.iter().any(|item| contains_key_recursive(item, key)),
        _ => false,
    }
}
