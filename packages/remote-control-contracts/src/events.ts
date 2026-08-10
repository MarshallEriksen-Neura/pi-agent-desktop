import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId } from "./projects";
import type {
  InteractionId,
  RemoteInteractionKind,
  RemoteInteractionResponse,
  RemoteTaskError,
  RemoteTaskId,
  RemoteTaskSnapshot,
  RemoteTaskState,
} from "./tasks";

export type EventId = string;
export type EventSequence = number;

export interface RemoteEventBase {
  /**
   * Stable, globally-unique event identifier (UUID v4 or ULID). Used for
   * de-duplication across reconnects under at-least-once delivery (AC9).
   * Clients MUST track seen `eventId`s and drop duplicates.
   */
  readonly eventId: EventId;
  readonly emittedAt: IsoTimestamp;
  readonly sequence: EventSequence;
  readonly deviceId: DeviceId;
}

// ---------------------------------------------------------------------------
// Task lifecycle events
// ---------------------------------------------------------------------------

export interface RemoteTaskCreatedEvent extends RemoteEventBase {
  readonly kind: "task.created";
  readonly task: RemoteTaskSnapshot;
}

export interface RemoteTaskStateChangedEvent extends RemoteEventBase {
  readonly kind: "task.state_changed";
  readonly taskId: RemoteTaskId;
  readonly from: RemoteTaskState;
  readonly to: RemoteTaskState;
  readonly error?: RemoteTaskError;
}

export interface RemoteTaskOutputAppendedEvent extends RemoteEventBase {
  readonly kind: "task.output_appended";
  readonly taskId: RemoteTaskId;
  /**
   * Best-effort output fragment (stdout/stderr/tool output). The gateway
   * retains at most 2 MiB of output per task; older fragments are dropped
   * once the envelope is full (plan Stage 5).
   */
  readonly fragment: string;
  readonly stream: "stdout" | "stderr" | "tool";
}

export interface RemoteTaskCompletedEvent extends RemoteEventBase {
  readonly kind: "task.completed";
  readonly taskId: RemoteTaskId;
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly error?: RemoteTaskError;
}

export interface RemoteTaskChangesEvent extends RemoteEventBase {
  /**
   * Synthetic event signalling that a task's snapshot changed and the client
   * should refetch via GET /api/v1/tasks/{taskId}. Emitted when the change
   * stream is saturated or when the gateway chooses not to ship a full delta.
   * (plan Stage 4)
   */
  readonly kind: "task.changes";
  readonly taskId: RemoteTaskId;
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// Interaction events (Stage 1: awaiting_input lifecycle)
// ---------------------------------------------------------------------------

export interface RemoteInteractionRequestedEvent extends RemoteEventBase {
  readonly kind: "interaction.requested";
  readonly interactionId: InteractionId;
  readonly taskId: RemoteTaskId;
  readonly interactionKind: RemoteInteractionKind;
  readonly prompt: string;
  readonly expiresAt: IsoTimestamp;
}

export interface RemoteInteractionResolvedEvent extends RemoteEventBase {
  readonly kind: "interaction.resolved";
  readonly interactionId: InteractionId;
  readonly taskId: RemoteTaskId;
  readonly response: RemoteInteractionResponse;
}

export interface RemoteInteractionExpiredEvent extends RemoteEventBase {
  readonly kind: "interaction.expired";
  readonly interactionId: InteractionId;
  readonly taskId: RemoteTaskId;
}

// ---------------------------------------------------------------------------
// Control-lane signals
// ---------------------------------------------------------------------------

/**
 * Replay signal: the client's `after` sequence is outside the retained event
 * window. The client MUST refetch task snapshots via
 * GET /api/v1/tasks?deviceId=... and restart the change stream from the
 * latest sequence. (plan Stage 1, AC9)
 */
export interface RemoteSnapshotRequiredEvent extends RemoteEventBase {
  readonly kind: "snapshot_required";
  readonly projectId?: ProjectId;
}

/**
 * Synthetic terminal event emitted when the control lane (WebSocket) is
 * saturated. The gateway cancels the in-flight task, commits a terminal
 * snapshot, and ships this event before closing the socket. The task's
 * `error.code` is `event_backpressure`. (plan Stage 5)
 */
export interface RemoteEventBackpressureEvent extends RemoteEventBase {
  readonly kind: "event_backpressure";
  readonly taskId: RemoteTaskId;
  readonly reason: "control_lane_saturated" | "retention_exceeded";
}

export type RemoteEvent =
  | RemoteTaskCreatedEvent
  | RemoteTaskStateChangedEvent
  | RemoteTaskOutputAppendedEvent
  | RemoteTaskCompletedEvent
  | RemoteTaskChangesEvent
  | RemoteInteractionRequestedEvent
  | RemoteInteractionResolvedEvent
  | RemoteInteractionExpiredEvent
  | RemoteSnapshotRequiredEvent
  | RemoteEventBackpressureEvent;

export type RemoteEventKind = RemoteEvent["kind"];

export function reduceRemoteTaskSnapshot(
  snapshot: RemoteTaskSnapshot,
  event: RemoteEvent,
): RemoteTaskSnapshot {
  switch (event.kind) {
    case "task.created":
      return event.task.taskId === snapshot.taskId ? event.task : snapshot;
    case "task.state_changed":
    case "task.completed":
    case "task.output_appended":
    case "task.changes":
    case "interaction.requested":
    case "interaction.resolved":
    case "interaction.expired":
    case "event_backpressure":
      return event.taskId === snapshot.taskId
        ? event.kind === "task.state_changed"
          ? { ...snapshot, state: event.to, error: event.error, updatedAt: event.emittedAt }
          : event.kind === "task.completed"
            ? { ...snapshot, state: event.state, error: event.error, updatedAt: event.emittedAt }
            : snapshot
        : snapshot;
    case "snapshot_required":
      return snapshot;
  }
}
