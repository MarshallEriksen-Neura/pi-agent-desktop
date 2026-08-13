import type { DeviceId, IsoTimestamp } from "./pairing";
import type { ProjectId, RelativeProjectPath } from "./projects";
import type { InteractionId, RemoteInteractionKind, RemoteInteractionResponseValue, RequestId } from "./tasks";

export const REMOTE_CONVERSATION_PROTOCOL_VERSION = 2 as const;
export const REMOTE_CONVERSATION_MAX_CONTEXT_FILES = 16 as const;
export const REMOTE_CONVERSATION_MAX_PROMPT_BYTES = 32 * 1024;
export const REMOTE_CONVERSATION_MAX_MESSAGE_TEXT_BYTES = 2 * 1024 * 1024;
export const REMOTE_CONVERSATION_MAX_DELTA_BYTES = 16 * 1024;
export const REMOTE_CONVERSATION_MAX_TOOL_SUMMARY_BYTES = 8 * 1024;
export const REMOTE_CONVERSATION_MAX_PAGE_SIZE = 100 as const;
export const REMOTE_CONVERSATION_MAX_QUEUED_TURNS = 8 as const;
export const REMOTE_CONVERSATION_GLOBAL_ACTIVE_TURNS = 1 as const;

export type RemoteConversationProtocolVersion = typeof REMOTE_CONVERSATION_PROTOCOL_VERSION;
export type RemoteConversationId = string;
export type RemoteTurnId = string;
export type RemoteMessageId = string;
export type RemoteDeliveryId = string;
export type RemoteCursor = string;

export interface RemoteConversationContextFile {
  readonly relativePath: RelativeProjectPath;
}

export type RemoteMessageRole = "user" | "assistant" | "system";
export type RemoteMessageStatus = "accepted" | "streaming" | "completed" | "failed" | "cancelled";

export type RemoteTurnState =
  | "queued"
  | "starting"
  | "running"
  | "awaiting_input"
  | "succeeded"
  | "failed"
  | "cancelled";

export const REMOTE_TURN_STATES: readonly RemoteTurnState[] = [
  "queued",
  "starting",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const REMOTE_TURN_TERMINAL_STATES: readonly RemoteTurnState[] = [
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type RemoteConversationStatus =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "awaiting_input"
  | "interrupted"
  | "archived"
  | "unavailable";

export type RemoteConversationErrorCode =
  | "invalid_context"
  | "queue_full"
  | "session_resume_unavailable"
  | "project_unavailable"
  | "project_revoked"
  | "process_failed"
  | "timeout"
  | "cancelled"
  | "host_interrupted"
  | "event_backpressure"
  | "internal_error";

export interface RemoteConversationError {
  readonly code: RemoteConversationErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface RemoteMessage {
  readonly messageId: RemoteMessageId;
  readonly conversationId: RemoteConversationId;
  readonly turnId: RemoteTurnId;
  readonly role: RemoteMessageRole;
  readonly status: RemoteMessageStatus;
  readonly text: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly error?: RemoteConversationError;
}

export interface RemoteTurnSnapshot {
  readonly turnId: RemoteTurnId;
  readonly conversationId: RemoteConversationId;
  readonly requestId: RequestId;
  readonly ownerDeviceId: DeviceId;
  readonly state: RemoteTurnState;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly userMessageId: RemoteMessageId;
  readonly assistantMessageId?: RemoteMessageId;
  readonly pendingInteractionId?: InteractionId;
  readonly delivery?: RemoteDeliverySnapshot;
  readonly error?: RemoteConversationError;
}

export interface RemoteConversationSnapshot {
  readonly version: RemoteConversationProtocolVersion;
  readonly conversationId: RemoteConversationId;
  readonly ownerDeviceId: DeviceId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly status: RemoteConversationStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly archivedAt?: IsoTimestamp;
  readonly activeTurn?: RemoteTurnSnapshot;
  readonly latestTurn?: RemoteTurnSnapshot;
  readonly latestMessage?: RemoteMessage;
  readonly pendingInteraction?: RemoteConversationInteractionSnapshot;
  readonly messageCount: number;
  readonly turnCount: number;
  readonly queuedTurnCount: number;
  readonly capabilities: RemoteConversationCapabilities;
}

export interface RemoteConversationSummary {
  readonly conversationId: RemoteConversationId;
  readonly ownerDeviceId: DeviceId;
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly status: RemoteConversationStatus;
  readonly updatedAt: IsoTimestamp;
  readonly latestTurnState?: RemoteTurnState;
  readonly latestMessagePreview?: string;
  readonly pendingInteractionId?: InteractionId;
  readonly queuedTurnCount: number;
}

export interface RemoteDeliverySnapshot {
  readonly deliveryId: RemoteDeliveryId;
  readonly conversationId: RemoteConversationId;
  readonly turnId: RemoteTurnId;
  readonly status: RemoteTurnDeliveryState;
  readonly acceptedAt: IsoTimestamp;
  readonly deliveredAt?: IsoTimestamp;
  readonly failedAt?: IsoTimestamp;
  readonly error?: RemoteConversationError;
}

export type RemoteTurnDeliveryState = "accepted" | "delivered" | "failed";

export interface RemoteConversationInteractionOption {
  readonly label: string;
  readonly value: string;
}

export type RemoteConversationInteractionStatus = "pending" | "resolved" | "expired";

export interface RemoteConversationInteractionSnapshot {
  readonly interactionId: InteractionId;
  readonly conversationId: RemoteConversationId;
  readonly turnId: RemoteTurnId;
  readonly kind: RemoteInteractionKind;
  readonly status: RemoteConversationInteractionStatus;
  readonly prompt: string;
  readonly options?: readonly RemoteConversationInteractionOption[];
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly response?: RemoteInteractionResponseSnapshot;
}

export interface RemoteInteractionResponseSnapshot {
  readonly interactionId: InteractionId;
  readonly kind: RemoteInteractionKind;
  readonly value: RemoteInteractionResponseValue;
  readonly submittedAt: IsoTimestamp;
}

export interface RemoteConversationCapabilities {
  readonly conversationV2: boolean;
  readonly piSessionResume: boolean;
  readonly appendTurns: boolean;
  readonly cancelTurn: boolean;
  readonly interactions: boolean;
  readonly messagePaging: boolean;
  readonly eventReplay: boolean;
  readonly maxQueuedTurns: typeof REMOTE_CONVERSATION_MAX_QUEUED_TURNS;
  readonly maxPromptBytes: typeof REMOTE_CONVERSATION_MAX_PROMPT_BYTES;
  readonly maxContextFiles: typeof REMOTE_CONVERSATION_MAX_CONTEXT_FILES;
  readonly maxPageSize: typeof REMOTE_CONVERSATION_MAX_PAGE_SIZE;
}

export interface RemoteConversationCreateRequest {
  readonly requestId: RequestId;
  readonly projectId: ProjectId;
  readonly prompt: string;
  readonly contextFiles: readonly RemoteConversationContextFile[];
}

export interface RemoteConversationCreateResponse {
  readonly conversation: RemoteConversationSnapshot;
  readonly turn: RemoteTurnSnapshot;
  readonly userMessage: RemoteMessage;
  readonly delivery: RemoteDeliverySnapshot;
}

export interface RemoteTurnAppendRequest {
  readonly requestId: RequestId;
  readonly prompt: string;
  readonly contextFiles?: readonly RemoteConversationContextFile[];
}

export interface RemoteTurnAppendResponse {
  readonly conversation: RemoteConversationSnapshot;
  readonly turn: RemoteTurnSnapshot;
  readonly userMessage: RemoteMessage;
  readonly delivery: RemoteDeliverySnapshot;
  readonly duplicate: boolean;
}

export interface RemoteTurnCancelRequest {
  readonly requestId: RequestId;
}

export interface RemoteTurnCancelResponse {
  readonly conversation: RemoteConversationSnapshot;
  readonly turn: RemoteTurnSnapshot;
  readonly duplicate: boolean;
}

export interface RemoteConversationListResponse {
  readonly conversations: readonly RemoteConversationSummary[];
  readonly nextCursor?: RemoteCursor;
}

export interface RemoteMessagePageResponse {
  readonly conversationId: RemoteConversationId;
  readonly messages: readonly RemoteMessage[];
  readonly nextCursor?: RemoteCursor;
}

export interface RemoteTurnTransition {
  readonly from: RemoteTurnState;
  readonly to: RemoteTurnState;
}

const ALLOWED_TURN_TRANSITIONS: Readonly<Record<RemoteTurnState, readonly RemoteTurnState[]>> = {
  queued: ["starting", "cancelled", "failed"],
  starting: ["running", "cancelled", "failed"],
  running: ["awaiting_input", "succeeded", "failed", "cancelled"],
  awaiting_input: ["running", "cancelled", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isRemoteTurnTerminalState(state: RemoteTurnState): boolean {
  return REMOTE_TURN_TERMINAL_STATES.includes(state);
}

export function canTransitionRemoteTurn(from: RemoteTurnState, to: RemoteTurnState): boolean {
  return ALLOWED_TURN_TRANSITIONS[from].includes(to);
}

export function assertRemoteTurnTransition(from: RemoteTurnState, to: RemoteTurnState): RemoteTurnTransition {
  if (!canTransitionRemoteTurn(from, to)) {
    throw new Error(`Invalid remote turn transition: ${from} -> ${to}`);
  }

  return { from, to };
}

export function transitionRemoteTurn(
  snapshot: RemoteTurnSnapshot,
  nextState: RemoteTurnState,
  updatedAt: IsoTimestamp,
  error?: RemoteConversationError,
): RemoteTurnSnapshot {
  assertRemoteTurnTransition(snapshot.state, nextState);

  return {
    ...snapshot,
    state: nextState,
    updatedAt,
    startedAt: nextState === "running" && !snapshot.startedAt ? updatedAt : snapshot.startedAt,
    finishedAt: isRemoteTurnTerminalState(nextState) ? updatedAt : snapshot.finishedAt,
    pendingInteractionId: nextState === "awaiting_input" ? snapshot.pendingInteractionId : undefined,
    error,
  };
}

export function deriveRemoteConversationStatus(
  snapshot: Pick<RemoteConversationSnapshot, "archivedAt" | "activeTurn" | "latestTurn">,
): RemoteConversationStatus {
  if (snapshot.archivedAt) {
    return "archived";
  }

  const turn = snapshot.activeTurn ?? snapshot.latestTurn;

  if (!turn) {
    return "idle";
  }

  switch (turn.state) {
    case "queued":
    case "starting":
    case "running":
    case "awaiting_input":
      return turn.state;
    case "failed":
      return turn.error?.code === "host_interrupted" ? "interrupted" : "idle";
    case "succeeded":
    case "cancelled":
      return "idle";
  }
}

export function deriveRemoteConversationStatusWithAvailability(
  snapshot: Pick<RemoteConversationSnapshot, "archivedAt" | "activeTurn" | "latestTurn">,
  available: boolean,
): RemoteConversationStatus {
  if (snapshot.archivedAt) return "archived";
  if (!available) return "unavailable";
  return deriveRemoteConversationStatus(snapshot);
}
