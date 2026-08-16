"use client";

import { create } from "zustand";
import type {
  RemoteConversationSnapshot,
  RemoteMessage,
} from "@pi/remote-control-contracts";
import { getPort } from "@/lib/backend/composition/container";

const POLL_INTERVAL_MS = 2_000;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshing = false;

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
  loading: boolean;
  error: string | null;
  sending: boolean;
  refresh: () => Promise<void>;
  select: (conversationId: string) => Promise<void>;
  append: (prompt: string, modelRef?: string) => Promise<boolean>;
  cancelActive: () => Promise<void>;
  archive: (conversationId: string) => Promise<void>;
  start: () => void;
  stop: () => void;
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
      let selectedId = get().selectedId;
      if (selectedId && !conversations.some((item) => item.conversationId === selectedId)) {
        selectedId = null;
      }
      if (!selectedId && conversations.length > 0) {
        selectedId = conversations[0].conversationId;
      }
      const detail = selectedId ? await loadSelected(selectedId) : null;
      set({
        conversations,
        selectedId,
        selected: detail?.snapshot ?? null,
        messages: detail?.messages ?? [],
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
    set({ selectedId: conversationId, selected: null, messages: [], error: null });
    try {
      const detail = await loadSelected(conversationId);
      if (get().selectedId !== conversationId) return;
      set({ selected: detail.snapshot, messages: detail.messages });
    } catch (error) {
      if (get().selectedId === conversationId) set({ error: message(error) });
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
      if (get().selectedId === conversationId) {
        set({ selectedId: null, selected: null, messages: [] });
      }
      await get().refresh();
    } catch (error) {
      set({ error: message(error) });
    }
  },

  start: () => {
    void get().refresh();
    if (!pollTimer) {
      pollTimer = setInterval(() => void get().refresh(), POLL_INTERVAL_MS);
    }
  },

  stop: () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  },
}));
