"use client";

import { create } from "zustand";
import type {
  RemoteConversationSnapshot,
  RemoteMessage,
} from "@pi/remote-control-contracts";
import { getPort } from "@/lib/backend/composition/container";
import { setActiveTaskId, useTaskContext } from "@/lib/pi/task-context";

/**
 * Remote conversations — the ones started from a paired phone.
 *
 * These live in the sidebar alongside local sessions, so this store is polled
 * for as long as the sidebar is mounted rather than for the lifetime of a page.
 * Two consequences shape the design:
 *
 *  1. `refresh` never auto-selects. The old standalone page picked the newest
 *     conversation on load because it had nothing else to show; here a
 *     selection means "the chat surface is showing a remote conversation", so
 *     selecting on a background poll would yank the user out of a local
 *     session mid-sentence.
 *  2. Polling is ref-counted and two-speed — the list alone while nothing is
 *     focused, list + transcript while a remote conversation is on screen.
 *     A permanently-mounted 2s poll of both is pure background cost.
 *
 * Focus is mutually exclusive with local sessions: selecting a remote
 * conversation is a *local* focus change too (there is one chat surface), so
 * `select` parks the local task id and a subscription to `task-context` drops
 * the remote selection as soon as a local session takes focus back.
 */

/** Poll cadence while a remote conversation is on screen (list + transcript). */
const ACTIVE_POLL_MS = 2_000;
/** Poll cadence while the sidebar only needs the list. */
const IDLE_POLL_MS = 6_000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Cadence the live timer was created with, so we only restart on a change. */
let pollCadence: number | null = null;
let subscribers = 0;
let refreshing = false;
/** Local task id to restore focus to when the remote selection is dropped. */
let parkedTaskId: string | null = null;

function requestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface RemoteConversationsState {
  conversations: readonly RemoteConversationSnapshot[];
  selectedId: string | null;
  selected: RemoteConversationSnapshot | null;
  messages: readonly RemoteMessage[];
  /** true until the first list response lands — drives the sidebar placeholder */
  loading: boolean;
  error: string | null;
  sending: boolean;
  refresh: () => Promise<void>;
  /** Focus a remote conversation on the chat surface. */
  select: (conversationId: string) => Promise<void>;
  /** Hand focus back to the local session (no-op when nothing is selected). */
  deselect: () => void;
  append: (prompt: string, modelRef?: string) => Promise<boolean>;
  cancelActive: () => Promise<void>;
  archive: (conversationId: string) => Promise<void>;
  /** Start polling; returns the matching release. Ref-counted. */
  acquire: () => () => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSelected(conversationId: string) {
  const port = getPort("remoteConversations");
  const [snapshot, page] = await Promise.all([
    port.get(conversationId),
    port.messages(conversationId, undefined, 100),
  ]);
  return { snapshot, messages: page.messages };
}

export const useRemoteConversations = create<RemoteConversationsState>((set, get) => ({
  conversations: [],
  selectedId: null,
  selected: null,
  messages: [],
  loading: true,
  error: null,
  sending: false,

  refresh: async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const conversations = await getPort("remoteConversations").list(100);
      // A selected conversation that vanished (archived elsewhere, gateway
      // reset) releases the chat surface back to the local session.
      const selectedId = get().selectedId;
      const stillListed =
        selectedId !== null &&
        conversations.some((item) => item.conversationId === selectedId);
      if (selectedId !== null && !stillListed) {
        set({ conversations, loading: false, error: null });
        get().deselect();
        return;
      }
      const detail = stillListed ? await loadSelected(selectedId!) : null;
      set({
        conversations,
        selected: detail?.snapshot ?? get().selected,
        messages: detail?.messages ?? get().messages,
        loading: false,
        error: null,
      });
    } catch (error) {
      set({ loading: false, error: message(error) });
    } finally {
      refreshing = false;
    }
  },

  select: async (conversationId) => {
    if (get().selectedId === conversationId) return;
    // Remember where to return focus, but only on the first remote selection —
    // switching between two remote conversations must not park a remote id.
    if (get().selectedId === null) {
      parkedTaskId = useTaskContext.getState().activeTaskId;
    }
    set({ selectedId: conversationId, selected: null, messages: [], error: null });
    retune();
    try {
      const detail = await loadSelected(conversationId);
      if (get().selectedId !== conversationId) return;
      set({ selected: detail.snapshot, messages: detail.messages });
    } catch (error) {
      if (get().selectedId === conversationId) set({ error: message(error) });
    }
  },

  deselect: () => {
    if (get().selectedId === null) return;
    set({ selectedId: null, selected: null, messages: [], error: null });
    retune();
    // Restore the local conversation that was on screen before.
    if (parkedTaskId) {
      setActiveTaskId(parkedTaskId);
      parkedTaskId = null;
    }
  },

  append: async (prompt, modelRef) => {
    const { selectedId } = get();
    if (!selectedId || !prompt.trim() || get().sending) return false;
    set({ sending: true, error: null });
    try {
      await getPort("remoteConversations").append(
        selectedId,
        prompt.trim(),
        requestId(),
        modelRef,
      );
      await get().refresh();
      return true;
    } catch (error) {
      set({ error: message(error) });
      return false;
    } finally {
      set({ sending: false });
    }
  },

  cancelActive: async () => {
    const { selectedId, selected } = get();
    const activeTurn = selected?.activeTurn;
    if (!selectedId || !activeTurn) return;
    try {
      await getPort("remoteConversations").cancel(selectedId, activeTurn.turnId);
      await get().refresh();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  archive: async (conversationId) => {
    try {
      await getPort("remoteConversations").archive(conversationId);
      if (get().selectedId === conversationId) get().deselect();
      await get().refresh();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  acquire: () => {
    subscribers += 1;
    if (subscribers === 1) {
      void get().refresh();
      retune();
    }
    let released = false;
    return () => {
      if (released) return; // idempotent — StrictMode double-invokes cleanups
      released = true;
      subscribers = Math.max(0, subscribers - 1);
      if (subscribers === 0) {
        stopTimer();
        useRemoteConversations.getState().deselect();
      }
    };
  },
}));

/* ── polling ── */

function stopTimer() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  pollCadence = null;
}

/**
 * Point the timer at the cadence the current state needs. Called on
 * acquire/release and whenever the selection changes.
 */
function retune() {
  if (subscribers === 0) {
    stopTimer();
    return;
  }
  const cadence =
    useRemoteConversations.getState().selectedId === null ? IDLE_POLL_MS : ACTIVE_POLL_MS;
  if (pollTimer && pollCadence === cadence) return;
  stopTimer();
  pollCadence = cadence;
  pollTimer = setInterval(() => void useRemoteConversations.getState().refresh(), cadence);
}

/* ── focus arbitration ──
   One chat surface, two kinds of conversation. `useSessions` owns the local
   focus and calls `setActiveTaskId` for every switch/new/delete; when it does,
   the remote selection has lost the surface and must clear itself. Guarded on
   `parkedTaskId` so `deselect`'s own restore doesn't recurse. */
useTaskContext.subscribe((state, previous) => {
  if (state.activeTaskId === previous.activeTaskId) return;
  const { selectedId, deselect } = useRemoteConversations.getState();
  if (selectedId === null) return;
  if (parkedTaskId !== null && state.activeTaskId === parkedTaskId) return;
  parkedTaskId = null; // a local session took the surface; nothing to restore
  deselect();
});
