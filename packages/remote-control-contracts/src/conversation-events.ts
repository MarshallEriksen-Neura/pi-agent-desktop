import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId } from "./projects";
import type { InteractionId, RemoteInteractionKind } from "./tasks";
import type {
  RemoteConversationError,
  RemoteConversationId,
  RemoteConversationSnapshot,
  RemoteConversationStatus,
  RemoteDeliverySnapshot,
  RemoteInteractionResponseSnapshot,
  RemoteMessage,
  RemoteMessageId,
  RemoteTurnId,
  RemoteTurnSnapshot,
  RemoteTurnState,
} from "./conversations";
import { deriveRemoteConversationStatus, isRemoteTurnTerminalState } from "./conversations";
import type { EventId, EventSequence } from "./events";

export interface RemoteConversationEventBase {
  readonly eventId: EventId;
  readonly emittedAt: IsoTimestamp;
  readonly sequence: EventSequence;
  readonly deviceId: DeviceId;
  readonly conversationId: RemoteConversationId;
}

export interface RemoteConversationCreatedEvent extends RemoteConversationEventBase {
  readonly kind: "conversation.created";
  readonly conversation: RemoteConversationSnapshot;
}

export interface RemoteConversationStatusChangedEvent extends RemoteConversationEventBase {
  readonly kind: "conversation.status_changed";
  readonly from: RemoteConversationStatus;
  readonly to: RemoteConversationStatus;
}

export interface RemoteTurnCreatedEvent extends RemoteConversationEventBase {
  readonly kind: "turn.created";
  readonly turn: RemoteTurnSnapshot;
}

export interface RemoteTurnStateChangedEvent extends RemoteConversationEventBase {
  readonly kind: "turn.state_changed";
  readonly turnId: RemoteTurnId;
  readonly from: RemoteTurnState;
  readonly to: RemoteTurnState;
  readonly error?: RemoteConversationError;
}

export interface RemoteTurnCompletedEvent extends RemoteConversationEventBase {
  readonly kind: "turn.completed";
  readonly turnId: RemoteTurnId;
  readonly state: "succeeded" | "failed" | "cancelled";
  readonly assistantMessageId?: RemoteMessageId;
  readonly error?: RemoteConversationError;
}

export interface RemoteMessageAcceptedEvent extends RemoteConversationEventBase {
  readonly kind: "message.accepted";
  readonly message: RemoteMessage;
  readonly delivery: RemoteDeliverySnapshot;
}

export interface RemoteMessageDeltaEvent extends RemoteConversationEventBase {
  readonly kind: "message.delta";
  readonly turnId: RemoteTurnId;
  readonly messageId: RemoteMessageId;
  readonly delta: string;
}

export interface RemoteMessageCompletedEvent extends RemoteConversationEventBase {
  readonly kind: "message.completed";
  readonly message: RemoteMessage;
}

export interface RemoteToolStartedEvent extends RemoteConversationEventBase {
  readonly kind: "tool.started";
  readonly turnId: RemoteTurnId;
  readonly toolCallId: string;
  readonly name: string;
  readonly summary?: string;
}

export interface RemoteToolCompletedEvent extends RemoteConversationEventBase {
  readonly kind: "tool.completed";
  readonly turnId: RemoteTurnId;
  readonly toolCallId: string;
  readonly name: string;
  readonly summary?: string;
  readonly isError: boolean;
}

export interface RemoteConversationInteractionRequestedEvent extends RemoteConversationEventBase {
  readonly kind: "interaction.requested";
  readonly interactionId: InteractionId;
  readonly turnId: RemoteTurnId;
  readonly interactionKind: RemoteInteractionKind;
  readonly prompt: string;
  readonly expiresAt: IsoTimestamp;
}

export interface RemoteConversationInteractionResolvedEvent extends RemoteConversationEventBase {
  readonly kind: "interaction.resolved";
  readonly interactionId: InteractionId;
  readonly turnId: RemoteTurnId;
  readonly response: RemoteInteractionResponseSnapshot;
}

export interface RemoteConversationInteractionExpiredEvent extends RemoteConversationEventBase {
  readonly kind: "interaction.expired";
  readonly interactionId: InteractionId;
  readonly turnId: RemoteTurnId;
}

export interface RemoteConversationSnapshotRequiredEvent extends RemoteConversationEventBase {
  readonly kind: "snapshot_required";
  readonly projectId?: ProjectId;
  readonly reason: "cursor_expired" | "retention_exceeded" | "gap_detected" | "backpressure";
}

export type RemoteConversationEvent =
  | RemoteConversationCreatedEvent
  | RemoteConversationStatusChangedEvent
  | RemoteTurnCreatedEvent
  | RemoteTurnStateChangedEvent
  | RemoteTurnCompletedEvent
  | RemoteMessageAcceptedEvent
  | RemoteMessageDeltaEvent
  | RemoteMessageCompletedEvent
  | RemoteToolStartedEvent
  | RemoteToolCompletedEvent
  | RemoteConversationInteractionRequestedEvent
  | RemoteConversationInteractionResolvedEvent
  | RemoteConversationInteractionExpiredEvent
  | RemoteConversationSnapshotRequiredEvent;

export type RemoteConversationEventKind = RemoteConversationEvent["kind"];

export interface RemoteConversationReducerState {
  readonly snapshot: RemoteConversationSnapshot;
  readonly lastSequence: EventSequence;
  readonly needsSnapshot: boolean;
  readonly seenTurnIds: ReadonlySet<RemoteTurnId>;
  readonly seenMessageIds: ReadonlySet<RemoteMessageId>;
}

/**
 * Creates client-local replay state around an authoritative server snapshot.
 * The sequence is the cursor returned with that snapshot; reducer metadata is
 * deliberately kept out of the wire DTO.
 */
export function createRemoteConversationReducerState(
  snapshot: RemoteConversationSnapshot,
  lastSequence: EventSequence,
): RemoteConversationReducerState {
  const seenTurnIds = new Set<RemoteTurnId>();
  const seenMessageIds = new Set<RemoteMessageId>();

  if (snapshot.activeTurn) seenTurnIds.add(snapshot.activeTurn.turnId);
  if (snapshot.latestTurn) seenTurnIds.add(snapshot.latestTurn.turnId);
  if (snapshot.latestMessage) seenMessageIds.add(snapshot.latestMessage.messageId);

  return {
    snapshot,
    lastSequence,
    needsSnapshot: false,
    seenTurnIds,
    seenMessageIds,
  };
}

/**
 * Applies an at-least-once event stream without regressing on duplicates or
 * out-of-order frames. Sequence jumps are allowed because unrelated entity
 * events can share the owner-scoped stream; an explicit `snapshot_required`
 * event is the authoritative signal that replay coverage was missed.
 */
export function reduceRemoteConversationState(
  state: RemoteConversationReducerState,
  event: RemoteConversationEvent,
): RemoteConversationReducerState {
  if (event.conversationId !== state.snapshot.conversationId || state.needsSnapshot) {
    return state;
  }

  if (event.sequence <= state.lastSequence) {
    return state;
  }

  if (event.kind === "snapshot_required") {
    return {
      ...state,
      lastSequence: event.sequence,
      needsSnapshot: true,
    };
  }

  const seenTurnIds = new Set(state.seenTurnIds);
  const seenMessageIds = new Set(state.seenMessageIds);
  let snapshot = state.snapshot;

  if (event.kind === "turn.created") {
    const isNewTurn = !seenTurnIds.has(event.turn.turnId);
    seenTurnIds.add(event.turn.turnId);
    snapshot = reduceRemoteConversationSnapshot(snapshot, event, isNewTurn);
  } else if (event.kind === "message.accepted" || event.kind === "message.completed") {
    const isNewMessage = !seenMessageIds.has(event.message.messageId);
    seenMessageIds.add(event.message.messageId);
    snapshot = reduceRemoteConversationSnapshot(snapshot, event, undefined, isNewMessage);
  } else if (event.kind === "message.delta") {
    const isNewMessage = !seenMessageIds.has(event.messageId);
    seenMessageIds.add(event.messageId);
    snapshot = reduceRemoteConversationSnapshot(snapshot, event, undefined, isNewMessage);
  } else {
    snapshot = reduceRemoteConversationSnapshot(snapshot, event);
  }

  return {
    snapshot,
    lastSequence: event.sequence,
    needsSnapshot: false,
    seenTurnIds,
    seenMessageIds,
  };
}

export function reduceRemoteConversationSnapshot(
  snapshot: RemoteConversationSnapshot,
  event: RemoteConversationEvent,
  countCreatedTurn = event.kind === "turn.created" &&
    snapshot.activeTurn?.turnId !== event.turn.turnId &&
    snapshot.latestTurn?.turnId !== event.turn.turnId,
  countAcceptedMessage = (event.kind === "message.accepted" || event.kind === "message.completed") &&
    snapshot.latestMessage?.messageId !== event.message.messageId,
): RemoteConversationSnapshot {
  if (event.conversationId !== snapshot.conversationId) {
    return snapshot;
  }

  switch (event.kind) {
    case "conversation.created":
      return event.conversation;
    case "conversation.status_changed":
      return { ...snapshot, status: event.to, updatedAt: event.emittedAt };
    case "turn.created": {
      const next = {
        ...snapshot,
        activeTurn: event.turn,
        latestTurn: event.turn,
        turnCount: snapshot.turnCount + (countCreatedTurn ? 1 : 0),
        queuedTurnCount:
          event.turn.state === "queued" && countCreatedTurn
            ? snapshot.queuedTurnCount + 1
            : snapshot.queuedTurnCount,
        updatedAt: event.emittedAt,
      };

      return { ...next, status: deriveRemoteConversationStatus(next) };
    }
    case "turn.state_changed": {
      const activeTurn = patchTurnState(snapshot.activeTurn, event.turnId, event.to, event.emittedAt, event.error);
      const latestTurn = patchTurnState(snapshot.latestTurn, event.turnId, event.to, event.emittedAt, event.error);
      const next = {
        ...snapshot,
        activeTurn: activeTurn && isRemoteTurnTerminalState(activeTurn.state) ? undefined : activeTurn,
        latestTurn,
        queuedTurnCount:
          event.from === "queued" && event.to !== "queued"
            ? Math.max(0, snapshot.queuedTurnCount - 1)
            : snapshot.queuedTurnCount,
        updatedAt: event.emittedAt,
      };

      return { ...next, status: deriveRemoteConversationStatus(next) };
    }
    case "turn.completed": {
      const activeTurn = patchTurnState(snapshot.activeTurn, event.turnId, event.state, event.emittedAt, event.error);
      const latestTurn = patchTurnState(snapshot.latestTurn, event.turnId, event.state, event.emittedAt, event.error);
      const next = {
        ...snapshot,
        activeTurn: activeTurn?.turnId === event.turnId ? undefined : activeTurn,
        latestTurn,
        updatedAt: event.emittedAt,
      };

      return { ...next, status: deriveRemoteConversationStatus(next) };
    }
    case "message.accepted":
    case "message.completed": {
      if (snapshot.latestMessage?.messageId === event.message.messageId) {
        return { ...snapshot, latestMessage: event.message, updatedAt: event.emittedAt };
      }

      return {
        ...snapshot,
        latestMessage: event.message,
        messageCount: snapshot.messageCount + (countAcceptedMessage ? 1 : 0),
        updatedAt: event.emittedAt,
      };
    }
    case "message.delta": {
      const current = snapshot.latestMessage;
      if (
        current?.messageId === event.messageId &&
        (current.status === "completed" || current.status === "failed" || current.status === "cancelled")
      ) {
        return snapshot;
      }
      const message: RemoteMessage = current?.messageId === event.messageId
        ? {
            ...current,
            status: "streaming",
            text: current.text + event.delta,
            updatedAt: event.emittedAt,
          }
        : {
            messageId: event.messageId,
            conversationId: event.conversationId,
            turnId: event.turnId,
            role: "assistant",
            status: "streaming",
            text: event.delta,
            createdAt: event.emittedAt,
            updatedAt: event.emittedAt,
          };
      return {
        ...snapshot,
        latestMessage: message,
        messageCount: snapshot.messageCount + (countAcceptedMessage ? 1 : 0),
        updatedAt: event.emittedAt,
      };
    }
    case "tool.started":
    case "tool.completed":
    case "interaction.requested":
    case "interaction.resolved":
    case "interaction.expired":
    case "snapshot_required":
      return snapshot;
  }
}

function patchTurnState(
  turn: RemoteTurnSnapshot | undefined,
  turnId: RemoteTurnId,
  state: RemoteTurnState,
  updatedAt: IsoTimestamp,
  error?: RemoteConversationError,
): RemoteTurnSnapshot | undefined {
  if (!turn || turn.turnId !== turnId) {
    return turn;
  }

  return {
    ...turn,
    state,
    updatedAt,
    finishedAt: isRemoteTurnTerminalState(state) ? updatedAt : turn.finishedAt,
    error,
  };
}
