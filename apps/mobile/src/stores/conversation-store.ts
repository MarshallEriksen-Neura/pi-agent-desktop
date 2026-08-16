import { create } from "zustand";
import type {
  RemoteConversationCreateRequest,
  RemoteConversationEvent,
  RemoteConversationSnapshot,
  RemoteConversationSummary,
  RemoteMessage,
  RemoteTurnAppendRequest,
} from "@pi/remote-control-contracts";
import {
  createRemoteConversationReducerState,
  reduceRemoteConversationState,
} from "@pi/remote-control-contracts";
import type { RemoteConversationReducerState } from "@pi/remote-control-contracts";
import { useConnectionStore } from "./connection.store";
import { useConversationDrafts } from "./conversation-drafts";
import { NetError } from "@/net/errors";
import { conversationEventDispatcher } from "./conversation-event-dispatcher";
import { maybeNotifyConversationCompleted, maybeNotifyInteractionWaiting } from "@/services/notifications";

/**
 * Conversation store — server-authoritative durable transcripts (G006).
 *
 * Truth model:
 *  - The gateway's snapshot + paged messages are the ONLY source of the
 *    transcript. A message appears here only when the server durably
 *    accepted it (create/append response, or a message.* event).
 *  - Offline sends become drafts (conversation-drafts store). They are never
 *    merged into `messages`, never counted as turns, never rendered as
 *    delivered — reconnect reconciliation replaces local state wholesale.
 *  - Live/replayed v2 events flow through the contract reducer
 *    (reduceRemoteConversationState), which dedupes repeats, tolerates
 *    out-of-order frames, and raises needsSnapshot when replay coverage was
 *    missed. needsSnapshot triggers an authoritative refetch.
 *  - Terminal turn states are never resurrected by stale replays (enforced
 *    by the contract reducer + refetch-on-snapshot).
 */

export interface OpenConversation {
  readonly snapshot: RemoteConversationSnapshot;
  /** Server-authoritative messages in ascending ordinal order. */
  readonly messages: readonly RemoteMessage[];
  readonly reducerState: RemoteConversationReducerState;
  readonly loadingMessages: boolean;
}

interface ConversationStoreState {
  summaries: readonly RemoteConversationSummary[];
  open: OpenConversation | null;
  /** null = not probed yet; false = gateway keeps v2 fail-closed (503). */
  v2Available: boolean | null;
  /** Last capability probe failure. Transient failures do not disable a
   * previously available v2 runtime or silently switch new work to v1. */
  v2ProbeError: string | null;
  loading: boolean;
  error: string | null;
  lastEventSequence: number;

  probeCapabilities: () => Promise<boolean>;
  refreshConversations: () => Promise<void>;
  openConversation: (conversationId: string) => Promise<void>;
  closeConversation: () => void;
  /** Returns the created conversationId, or null when the send went offline
   *  and was parked as a draft (nothing was fabricated locally). */
  createConversation: (req: RemoteConversationCreateRequest) => Promise<string | null>;
  /** Returns true when the server durably accepted the follow-up. */
  appendTurn: (conversationId: string, req: RemoteTurnAppendRequest) => Promise<boolean>;
  cancelTurn: (turnId: string, requestId: string) => Promise<void>;
  archiveConversation: (conversationId: string, requestId: string) => Promise<void>;
  applyEvent: (event: RemoteConversationEvent) => void;
  /** REST replay from lastEventSequence; snapshotRequired forces reconcile. */
  replayEvents: () => Promise<void>;
  /** Reconnect reconciliation: authoritative refetch replaces local state. */
  reconcile: () => Promise<void>;
  reset: () => void;
}

function errorMessage(e: unknown): string {
  return e instanceof NetError ? e.message : "fetch_failed";
}

/** Merge one authoritative message into an ascending-ordinal list. */
function mergeMessage(messages: readonly RemoteMessage[], message: RemoteMessage): RemoteMessage[] {
  const idx = messages.findIndex((m) => m.messageId === message.messageId);
  if (idx === -1) return [...messages, message];
  const next = [...messages];
  next[idx] = message;
  return next;
}

function mergeMessageDelta(
  messages: readonly RemoteMessage[],
  event: Extract<RemoteConversationEvent, { kind: "message.delta" }>,
): RemoteMessage[] {
  const idx = messages.findIndex((message) => message.messageId === event.messageId);
  if (idx === -1) {
    return [
      ...messages,
      {
        messageId: event.messageId,
        conversationId: event.conversationId,
        turnId: event.turnId,
        role: "assistant",
        status: "streaming",
        text: event.delta,
        createdAt: event.emittedAt,
        updatedAt: event.emittedAt,
      },
    ];
  }
  const next = [...messages];
  const current = next[idx];
  if (current.status === "completed" || current.status === "failed" || current.status === "cancelled") {
    return messages.slice();
  }
  next[idx] = {
    ...current,
    status: "streaming",
    text: current.text + event.delta,
    updatedAt: event.emittedAt,
  };
  return next;
}

function summaryStatusForTurnState(
  state: RemoteConversationSummary["latestTurnState"],
): RemoteConversationSummary["status"] {
  switch (state) {
    case "queued":
    case "starting":
    case "running":
    case "awaiting_input":
      return state;
    case "succeeded":
    case "failed":
    case "cancelled":
      return "idle";
    default:
      return "idle";
  }
}

function applyEventToSummary(
  summary: RemoteConversationSummary,
  event: RemoteConversationEvent,
): RemoteConversationSummary {
  const next = { ...summary, updatedAt: event.emittedAt };
  switch (event.kind) {
    case "conversation.created":
      return summarize(event.conversation);
    case "conversation.status_changed":
      return { ...next, status: event.to };
    case "turn.created":
      return {
        ...next,
        status: summaryStatusForTurnState(event.turn.state),
        latestTurnState: event.turn.state,
        queuedTurnCount: next.queuedTurnCount + (event.turn.state === "queued" ? 1 : 0),
      };
    case "turn.state_changed":
      return {
        ...next,
        status: summaryStatusForTurnState(event.to),
        latestTurnState: event.to,
        queuedTurnCount:
          event.from === "queued" && event.to !== "queued"
            ? Math.max(0, next.queuedTurnCount - 1)
            : next.queuedTurnCount,
      };
    case "turn.completed":
      return { ...next, status: "idle", latestTurnState: event.state };
    case "message.accepted":
    case "message.completed":
      return { ...next, latestMessagePreview: event.message.text.slice(0, 140) };
    case "message.delta":
      return {
        ...next,
        latestMessagePreview: `${next.latestMessagePreview ?? ""}${event.delta}`.slice(0, 140),
      };
    case "interaction.requested":
      return { ...next, status: "awaiting_input", pendingInteractionId: event.interactionId };
    case "interaction.resolved":
    case "interaction.expired":
      return { ...next, pendingInteractionId: undefined };
    case "tool.started":
    case "tool.completed":
    case "snapshot_required":
      return next;
  }
}

export const useConversationStore = create<ConversationStoreState>((set, get) => ({
  summaries: [],
  open: null,
  v2Available: null,
  v2ProbeError: null,
  loading: false,
  error: null,
  lastEventSequence: 0,

  probeCapabilities: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return false;
    try {
      await client.getConversationCapabilities();
      set({ v2Available: true, v2ProbeError: null });
      return true;
    } catch (e) {
      const unavailable = e instanceof NetError && e.status === 503;
      set((state) => ({
        v2Available: unavailable ? false : state.v2Available,
        v2ProbeError: errorMessage(e),
      }));
      return false;
    }
  },

  refreshConversations: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    const isFirst = get().summaries.length === 0;
    set({ loading: isFirst, error: null });
    try {
      const res = await client.listConversations();
      set({ summaries: res.conversations, loading: false });
    } catch (e) {
      set({ error: errorMessage(e), loading: false });
    }
  },

  openConversation: async (conversationId) => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    set({ error: null });
    try {
      // Snapshot + first message page fetched together: the transcript shown
      // is entirely server-owned.
      const [snapshot, page] = await Promise.all([
        client.getConversation(conversationId),
        client.getConversationMessages(conversationId),
      ]);
      const reducerState = createRemoteConversationReducerState(snapshot, get().lastEventSequence);
      set({
        open: {
          snapshot,
          messages: [...page.messages],
          reducerState,
          loadingMessages: false,
        },
      });
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  closeConversation: () => set({ open: null }),

  createConversation: async (req) => {
    const client = useConnectionStore.getState().client;
    if (!client) return null;
    try {
      const res = await client.createConversation(req);
      // Durably accepted — the server response is the only source of truth.
      useConversationDrafts.getState().removeDraft(req.requestId);
      set((s) => ({
        summaries: [summarize(res.conversation), ...s.summaries.filter(
          (c) => c.conversationId !== res.conversation.conversationId,
        )],
      }));
      const open = get().open;
      if (open && open.snapshot.conversationId === res.conversation.conversationId) {
        set({
          open: {
            ...open,
            snapshot: res.conversation,
            messages: mergeMessage(open.messages, res.userMessage),
          },
        });
      }
      return res.conversation.conversationId;
    } catch (e) {
      // Offline or fail: park as a draft. Never fabricate an accepted
      // conversation locally — reconnect reconciliation will deliver it via
      // the idempotent requestId retry.
      useConversationDrafts.getState().addDraft({
        requestId: req.requestId,
        conversationId: null,
        projectId: req.projectId,
        prompt: req.prompt,
        createdAt: new Date().toISOString(),
      });
      set({ error: errorMessage(e) });
      return null;
    }
  },

  appendTurn: async (conversationId, req) => {
    const client = useConnectionStore.getState().client;
    if (!client) return false;
    try {
      const res = await client.appendTurn(conversationId, req);
      useConversationDrafts.getState().removeDraft(req.requestId);
      set((s) => ({
        summaries: s.summaries.map((c) =>
          c.conversationId === conversationId ? summarize(res.conversation) : c,
        ),
      }));
      const open = get().open;
      if (open && open.snapshot.conversationId === conversationId) {
        set({
          open: {
            ...open,
            snapshot: res.conversation,
            messages: mergeMessage(open.messages, res.userMessage),
          },
        });
      }
      return true;
    } catch (e) {
      const projectId =
        get().open?.snapshot.projectId ??
        get().summaries.find((c) => c.conversationId === conversationId)?.projectId ??
        "";
      useConversationDrafts.getState().addDraft({
        requestId: req.requestId,
        conversationId,
        projectId,
        prompt: req.prompt,
        createdAt: new Date().toISOString(),
      });
      set({ error: errorMessage(e) });
      return false;
    }
  },

  cancelTurn: async (turnId, requestId) => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    try {
      const res = await client.cancelTurn(turnId, requestId);
      set((s) => ({
        summaries: s.summaries.map((c) =>
          c.conversationId === res.conversation.conversationId
            ? summarize(res.conversation)
            : c,
        ),
      }));
      const open = get().open;
      if (open && open.snapshot.conversationId === res.conversation.conversationId) {
        set({ open: { ...open, snapshot: res.conversation } });
      }
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  archiveConversation: async (conversationId, requestId) => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    try {
      const res = await client.archiveConversation(conversationId, requestId);
      set((s) => ({
        summaries: s.summaries.map((summary) =>
          summary.conversationId === conversationId ? summarize(res.conversation) : summary,
        ),
      }));
      const open = get().open;
      if (open?.snapshot.conversationId === conversationId) {
        set({
          open: {
            ...open,
            snapshot: res.conversation,
            reducerState: createRemoteConversationReducerState(
              res.conversation,
              open.reducerState.lastSequence,
            ),
          },
        });
      }
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  applyEvent: (event) => {
    // Lifecycle notifications — checked before any branch so a turn that
    // completes in ANOTHER conversation still alerts. Dedup lives in the
    // service, and "user is watching this conversation" is decided there too.
    if (event.kind === "turn.completed" && event.state === "succeeded") {
      const open = get().open;
      const preview =
        open?.snapshot.conversationId === event.conversationId
          ? open.snapshot.latestMessage?.text
          : undefined;
      void maybeNotifyConversationCompleted(event.conversationId, preview);
    } else if (event.kind === "interaction.requested") {
      void maybeNotifyInteractionWaiting(event.conversationId, event.prompt);
    }
    const open = get().open;
    if (!open || event.conversationId !== open.snapshot.conversationId) {
      // Keep list metadata useful while another conversation is open. The
      // server remains authoritative; reconcile still replaces this projection.
      if (event.sequence > get().lastEventSequence) {
        set((state) => ({
          summaries: state.summaries.map((summary) =>
            summary.conversationId === event.conversationId
              ? applyEventToSummary(summary, event)
              : summary,
          ),
          lastEventSequence: event.sequence,
        }));
      }
      return;
    }
    if (event.sequence <= open.reducerState.lastSequence || open.reducerState.needsSnapshot) {
      return;
    }
    const reducerState = reduceRemoteConversationState(open.reducerState, event);
    let messages = open.messages;
    if (
      (event.kind === "message.accepted" || event.kind === "message.completed")
    ) {
      messages = mergeMessage(messages, event.message);
    } else if (event.kind === "message.delta") {
      messages = mergeMessageDelta(messages, event);
    }
    set({
      open: { ...open, snapshot: reducerState.snapshot, messages, reducerState },
      summaries: get().summaries.map((summary) =>
        summary.conversationId === event.conversationId
          ? applyEventToSummary(summary, event)
          : summary,
      ),
      lastEventSequence: Math.max(get().lastEventSequence, event.sequence),
    });
    if (reducerState.needsSnapshot) {
      // Replay coverage missed — authoritative refetch replaces local state.
      void get().openConversation(event.conversationId);
    }
  },

  replayEvents: async () => {
    const client = useConnectionStore.getState().client;
    if (!client) return;
    try {
      const after = get().lastEventSequence;
      const replay = await client.getConversationEvents(after > 0 ? after : undefined);
      if (replay.snapshotRequired) {
        await get().refreshConversations();
        const open = get().open;
        if (open) await get().openConversation(open.snapshot.conversationId);
        return;
      }
      for (const event of replay.events) {
        get().applyEvent(event);
      }
    } catch (e) {
      set({ error: errorMessage(e) });
    }
  },

  reconcile: async () => {
    // Authoritative refetch: replace, never merge. Drafts survive (they are
    // the only local-only state and are retried via idempotent requestIds).
    await get().refreshConversations();
    const open = get().open;
    if (open) {
      await get().openConversation(open.snapshot.conversationId);
    }
    await get().replayEvents();
  },

  reset: () =>
    set({
      summaries: [],
      open: null,
      v2Available: null,
      v2ProbeError: null,
      loading: false,
      error: null,
      lastEventSequence: 0,
    }),
}));

let subscribed = false;
export function initConversationEventSubscription(): () => void {
  if (subscribed) return () => {};
  subscribed = true;
  return conversationEventDispatcher.subscribe({
    onEvent: (event) => useConversationStore.getState().applyEvent(event),
    onSnapshotRequired: () => void useConversationStore.getState().reconcile(),
    onTerminalError: () => {},
  });
}

if (typeof window !== "undefined") {
  initConversationEventSubscription();
}

function summarize(snapshot: RemoteConversationSnapshot): RemoteConversationSummary {
  return {
    conversationId: snapshot.conversationId,
    ownerDeviceId: snapshot.ownerDeviceId,
    projectId: snapshot.projectId,
    title: snapshot.title,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    latestTurnState: snapshot.latestTurn?.state,
    latestMessagePreview: snapshot.latestMessage?.text.slice(0, 140),
    pendingInteractionId: snapshot.pendingInteraction?.interactionId,
    queuedTurnCount: snapshot.queuedTurnCount,
  };
}
