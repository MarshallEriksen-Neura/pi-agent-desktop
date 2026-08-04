import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId } from "./projects";
import {
  transitionRemoteTask,
  type RemoteTaskError,
  type RemoteTaskId,
  type RemoteTaskSnapshot,
  type RemoteTaskState,
} from "./tasks";

export type RemoteEventSequence = number;
export type RemoteEventCursor = string;

export interface RemoteEventBase {
  readonly sequence: RemoteEventSequence;
  readonly emittedAt: IsoTimestamp;
}

export interface RemoteTaskQueuedEvent extends RemoteEventBase {
  readonly type: "task.queued";
  readonly task: RemoteTaskSnapshot;
}

export interface RemoteTaskStateEvent extends RemoteEventBase {
  readonly type: "task.state";
  readonly taskId: RemoteTaskId;
  readonly state: RemoteTaskState;
  readonly error?: RemoteTaskError;
}

export interface RemoteTaskOutputEvent extends RemoteEventBase {
  readonly type: "task.output";
  readonly taskId: RemoteTaskId;
  readonly stream: "stdout" | "stderr" | "system";
  readonly text: string;
}

export interface RemoteProjectRevokedEvent extends RemoteEventBase {
  readonly type: "project.revoked";
  readonly projectId: ProjectId;
}

export interface RemoteDeviceRevokedEvent extends RemoteEventBase {
  readonly type: "device.revoked";
  readonly deviceId: DeviceId;
}

export type RemoteControlEvent =
  | RemoteTaskQueuedEvent
  | RemoteTaskStateEvent
  | RemoteTaskOutputEvent
  | RemoteProjectRevokedEvent
  | RemoteDeviceRevokedEvent;

export interface RemoteEventPage {
  readonly events: readonly RemoteControlEvent[];
  readonly nextCursor?: RemoteEventCursor;
}

export function isNextRemoteEventSequence(previous: RemoteEventSequence, next: RemoteEventSequence): boolean {
  return Number.isSafeInteger(next) && next > previous;
}

export function assertNextRemoteEventSequence(
  previous: RemoteEventSequence,
  next: RemoteEventSequence,
): RemoteEventSequence {
  if (!isNextRemoteEventSequence(previous, next)) {
    throw new Error(`Remote event sequence must increase: ${previous} -> ${next}`);
  }

  return next;
}

export function reduceRemoteTaskSnapshot(
  snapshot: RemoteTaskSnapshot | undefined,
  event: RemoteControlEvent,
): RemoteTaskSnapshot | undefined {
  if (event.type === "task.queued") {
    return event.task;
  }

  if (event.type !== "task.state" || !snapshot || snapshot.taskId !== event.taskId) {
    return snapshot;
  }

  return transitionRemoteTask(snapshot, event.state, event.emittedAt, event.error);
}
