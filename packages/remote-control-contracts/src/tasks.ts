import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId, RelativeProjectPath } from "./projects";

export type RequestId = string;
export type RemoteTaskId = string;
export type InteractionId = string;

export type RemoteTaskState =
  | "queued"
  | "starting"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

export const REMOTE_TASK_STATES: readonly RemoteTaskState[] = [
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const REMOTE_TASK_TERMINAL_STATES: readonly RemoteTaskState[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

export interface RemoteTaskContextFile {
  readonly relativePath: RelativeProjectPath;
}

/**
 * Optional execution profile for a remote task. v1 defines two presets;
 * the gateway enforces the 60-minute default deadline unless `extended` is
 * explicitly allowed by desktop policy.
 */
export type RemoteTaskExecutionProfile = "default" | "extended";

export interface RemoteTaskCreateRequest {
  readonly requestId: RequestId;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly contextFiles: readonly RemoteTaskContextFile[];
  readonly executionProfile?: RemoteTaskExecutionProfile;
}

export type RemoteTaskFailureCode =
  | "authentication_failed"
  | "project_unavailable"
  | "project_revoked"
  | "invalid_context"
  | "queue_full"
  | "process_failed"
  | "timeout"
  | "cancelled"
  | "desktop_restarted"
  | "event_backpressure"
  | "internal_error";

export interface RemoteTaskError {
  readonly code: RemoteTaskFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * Owner-scoped task snapshot. `ownerDeviceId` is the principal that created
 * the task; every list/detail/cancel/interaction/event authorization MUST be
 * owner-filtered before existence is disclosed (AC15).
 */
export interface RemoteTaskSnapshot {
  readonly taskId: RemoteTaskId;
  readonly requestId: RequestId;
  readonly ownerDeviceId: DeviceId;
  readonly projectId: ProjectId;
  readonly state: RemoteTaskState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly contextFiles: readonly RemoteTaskContextFile[];
  readonly error?: RemoteTaskError;
}

export interface RemoteTaskTransition {
  readonly from: RemoteTaskState;
  readonly to: RemoteTaskState;
}

const ALLOWED_TASK_TRANSITIONS: Readonly<Record<RemoteTaskState, readonly RemoteTaskState[]>> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "cancelled", "failed"],
  running: ["awaiting_input", "succeeded", "failed", "cancelled"],
  awaiting_input: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isRemoteTaskTerminalState(state: RemoteTaskState): boolean {
  return REMOTE_TASK_TERMINAL_STATES.includes(state);
}

export function canTransitionRemoteTask(from: RemoteTaskState, to: RemoteTaskState): boolean {
  return ALLOWED_TASK_TRANSITIONS[from].includes(to);
}

export function assertRemoteTaskTransition(from: RemoteTaskState, to: RemoteTaskState): RemoteTaskTransition {
  if (!canTransitionRemoteTask(from, to)) {
    throw new Error(`Invalid remote task transition: ${from} -> ${to}`);
  }

  return { from, to };
}

export function transitionRemoteTask(
  snapshot: RemoteTaskSnapshot,
  nextState: RemoteTaskState,
  updatedAt: IsoTimestamp,
  error?: RemoteTaskError,
): RemoteTaskSnapshot {
  assertRemoteTaskTransition(snapshot.state, nextState);

  return {
    ...snapshot,
    state: nextState,
    updatedAt,
    startedAt: nextState === "running" && !snapshot.startedAt ? updatedAt : snapshot.startedAt,
    finishedAt: isRemoteTaskTerminalState(nextState) ? updatedAt : snapshot.finishedAt,
    error,
  };
}

// ---------------------------------------------------------------------------
// Interactions (Stage 1: awaiting_input lifecycle)
// ---------------------------------------------------------------------------

/**
 * Bounded interaction kinds. Unknown kinds are rejected by the gateway rather
 * than exposed as arbitrary extension UI (plan Stage 1).
 */
export type RemoteInteractionKind = "confirm" | "select" | "input" | "editor";

export interface RemoteInteractionOption {
  readonly label: string;
  readonly value: string;
}

export interface RemoteInteractionRequest {
  readonly interactionId: InteractionId;
  readonly taskId: RemoteTaskId;
  readonly kind: RemoteInteractionKind;
  readonly prompt: string;
  readonly options?: readonly RemoteInteractionOption[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type RemoteInteractionResponseValue = boolean | string;

export interface RemoteInteractionResponse {
  readonly interactionId: InteractionId;
  readonly kind: RemoteInteractionKind;
  readonly value: RemoteInteractionResponseValue;
  readonly submittedAt: IsoTimestamp;
}

export type RemoteInteractionStatus = "pending" | "resolved" | "expired";

export interface RemoteInteractionSnapshot {
  readonly interactionId: InteractionId;
  readonly taskId: RemoteTaskId;
  readonly kind: RemoteInteractionKind;
  readonly status: RemoteInteractionStatus;
  readonly prompt: string;
  readonly options?: readonly RemoteInteractionOption[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly response?: RemoteInteractionResponse;
}
