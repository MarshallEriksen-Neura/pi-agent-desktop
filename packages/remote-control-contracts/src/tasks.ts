import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId, RelativeProjectPath } from "./projects";

export type RequestId = string;
export type RemoteTaskId = string;

export type RemoteTaskState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const REMOTE_TASK_STATES: readonly RemoteTaskState[] = [
  "queued",
  "starting",
  "running",
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

export interface RemoteTaskCreateRequest {
  readonly requestId: RequestId;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly contextFiles: readonly RemoteTaskContextFile[];
}

export type RemoteTaskFailureCode =
  | "authentication_failed"
  | "project_unavailable"
  | "invalid_context"
  | "queue_full"
  | "process_failed"
  | "timeout"
  | "cancelled"
  | "desktop_restarted"
  | "internal_error";

export interface RemoteTaskError {
  readonly code: RemoteTaskFailureCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RemoteTaskSnapshot {
  readonly taskId: RemoteTaskId;
  readonly requestId: RequestId;
  readonly deviceId: DeviceId;
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
  running: ["succeeded", "failed", "cancelled"],
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
