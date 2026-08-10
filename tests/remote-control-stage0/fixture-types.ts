import type {
  PairingFailure,
  PairingQrPayload,
  PairingRequest,
  PairingSuccess,
} from "../../packages/remote-control-contracts/src/pairing";
import type {
  RemoteProjectCapabilities,
  RemoteProjectSummary,
  RemoteTreePage,
} from "../../packages/remote-control-contracts/src/projects";
import type {
  RemoteEvent,
  RemoteInteractionRequestedEvent,
} from "../../packages/remote-control-contracts/src/events";
import type {
  RemoteInteractionRequest,
  RemoteInteractionResponse,
  RemoteInteractionSnapshot,
  RemoteTaskCreateRequest,
  RemoteTaskError,
  RemoteTaskSnapshot,
} from "../../packages/remote-control-contracts/src/tasks";

import pairingQr from "../../packages/remote-control-contracts/fixtures/v1/pairing/qr-payload.json";
import pairingRequest from "../../packages/remote-control-contracts/fixtures/v1/pairing/request.json";
import pairingSuccess from "../../packages/remote-control-contracts/fixtures/v1/pairing/success.json";
import pairingFailure from "../../packages/remote-control-contracts/fixtures/v1/pairing/failure-invalid-ticket.json";
import projectSummary from "../../packages/remote-control-contracts/fixtures/v1/projects/summary.json";
import treePage from "../../packages/remote-control-contracts/fixtures/v1/projects/tree-page.json";
import capabilities from "../../packages/remote-control-contracts/fixtures/v1/projects/capabilities.json";
import createRequest from "../../packages/remote-control-contracts/fixtures/v1/tasks/create-request.json";
import createRequestExtended from "../../packages/remote-control-contracts/fixtures/v1/tasks/create-request-extended.json";
import taskSnapshot from "../../packages/remote-control-contracts/fixtures/v1/tasks/snapshot-awaiting-input.json";
import taskError from "../../packages/remote-control-contracts/fixtures/v1/tasks/error-project-revoked.json";
import interactionRequest from "../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-request.json";
import interactionResponse from "../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-response.json";
import interactionSnapshot from "../../packages/remote-control-contracts/fixtures/v1/tasks/interaction-expired.json";
import taskCreated from "../../packages/remote-control-contracts/fixtures/v1/events/task-created.json";
import taskStateAwaitingInput from "../../packages/remote-control-contracts/fixtures/v1/events/task-state-awaiting-input.json";
import interactionRequested from "../../packages/remote-control-contracts/fixtures/v1/events/interaction-requested.json";
import snapshotRequired from "../../packages/remote-control-contracts/fixtures/v1/events/snapshot-required.json";
import eventBackpressure from "../../packages/remote-control-contracts/fixtures/v1/events/event-backpressure.json";

type JsonShape<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends readonly (infer Item)[]
        ? readonly JsonShape<Item>[]
        : T extends object
          ? { [Key in keyof T]: JsonShape<T[Key]> }
          : T;

export const typedFixtures = {
  pairingQr: pairingQr satisfies JsonShape<PairingQrPayload>,
  pairingRequest: pairingRequest satisfies JsonShape<PairingRequest>,
  pairingSuccess: pairingSuccess satisfies JsonShape<PairingSuccess>,
  pairingFailure: pairingFailure satisfies JsonShape<PairingFailure>,
  projectSummary: projectSummary satisfies JsonShape<RemoteProjectSummary>,
  treePage: treePage satisfies JsonShape<RemoteTreePage>,
  capabilities: capabilities satisfies JsonShape<RemoteProjectCapabilities>,
  createRequest: createRequest satisfies JsonShape<RemoteTaskCreateRequest>,
  createRequestExtended: createRequestExtended satisfies JsonShape<RemoteTaskCreateRequest>,
  taskSnapshot: taskSnapshot satisfies JsonShape<RemoteTaskSnapshot>,
  taskError: taskError satisfies JsonShape<RemoteTaskError>,
  interactionRequest: interactionRequest satisfies JsonShape<RemoteInteractionRequest>,
  interactionResponse: interactionResponse satisfies JsonShape<RemoteInteractionResponse>,
  interactionSnapshot: interactionSnapshot satisfies JsonShape<RemoteInteractionSnapshot>,
  taskCreated: taskCreated satisfies JsonShape<RemoteEvent>,
  taskStateAwaitingInput: taskStateAwaitingInput satisfies JsonShape<RemoteEvent>,
  interactionRequested: interactionRequested satisfies JsonShape<RemoteInteractionRequestedEvent>,
  snapshotRequired: snapshotRequired satisfies JsonShape<RemoteEvent>,
  eventBackpressure: eventBackpressure satisfies JsonShape<RemoteEvent>,
};
