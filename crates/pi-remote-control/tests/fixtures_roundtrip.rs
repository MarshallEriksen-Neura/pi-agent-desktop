use std::fmt::Debug;

use pi_remote_control::protocol::{
    PairingFailure, PairingQrPayload, PairingRequest, PairingSuccess, PolicyFixtureManifest,
    RemoteEvent, RemoteInteractionRequest, RemoteInteractionResponse, RemoteInteractionSnapshot,
    RemoteProjectCapabilities, RemoteProjectSummary, RemoteTaskCreateRequest, RemoteTaskError,
    RemoteTaskSnapshot, RemoteTreePage,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

#[test]
fn shared_fixtures_round_trip_through_rust_serde() {
    assert_round_trip::<PairingQrPayload>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/pairing/qr-payload.json"
    ));
    assert_round_trip::<PairingRequest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/pairing/request.json"
    ));
    assert_round_trip::<PairingSuccess>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/pairing/success.json"
    ));
    assert_round_trip::<PairingFailure>(include_str!("../../../packages/remote-control-contracts/fixtures/v1/pairing/failure-invalid-ticket.json"));
    assert_round_trip::<RemoteProjectSummary>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/projects/summary.json"
    ));
    assert_round_trip::<RemoteTreePage>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/projects/tree-page.json"
    ));
    assert_round_trip::<RemoteProjectCapabilities>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/projects/capabilities.json"
    ));
    assert_round_trip::<RemoteTaskCreateRequest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/create-request.json"
    ));
    assert_round_trip::<RemoteTaskCreateRequest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/create-request-extended.json"
    ));
    assert_round_trip::<RemoteTaskSnapshot>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/snapshot-awaiting-input.json"
    ));
    assert_round_trip::<RemoteTaskError>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/error-project-revoked.json"
    ));
    assert_round_trip::<RemoteInteractionRequest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-request.json"
    ));
    assert_round_trip::<RemoteInteractionResponse>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-response.json"
    ));
    assert_round_trip::<RemoteInteractionSnapshot>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-expired.json"
    ));
    assert_round_trip::<RemoteEvent>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/events/task-created.json"
    ));
    assert_round_trip::<RemoteEvent>(include_str!("../../../packages/remote-control-contracts/fixtures/v1/events/task-state-awaiting-input.json"));
    assert_round_trip::<RemoteEvent>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/events/interaction-requested.json"
    ));
    assert_round_trip::<RemoteEvent>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/events/snapshot-required.json"
    ));
    assert_round_trip::<RemoteEvent>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/events/event-backpressure.json"
    ));
    assert_round_trip::<PolicyFixtureManifest>(include_str!(
        "../../../packages/remote-control-contracts/fixtures/v1/errors/policy-violations.json"
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
