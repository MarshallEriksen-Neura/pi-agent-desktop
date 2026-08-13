import { create } from "zustand";

/**
 * Conversation drafts — offline send intents that the desktop has NOT
 * durably accepted yet.
 *
 * Hard rule (G006): a draft is never an accepted message. Drafts are not
 * merged into the server-authoritative transcript, never counted as turns,
 * and never rendered as delivered bubbles. They exist so the composer can
 * show "not delivered" state while offline; the only way a message enters
 * the transcript is a durable server acceptance (create/append response or a
 * message.accepted event).
 *
 * Keyed by requestId so a retried send after reconnect hits the gateway's
 * idempotency gate instead of double-delivering.
 */

export interface ConversationDraft {
  readonly requestId: string;
  /** null while the conversation itself has not been created yet. */
  readonly conversationId: string | null;
  readonly projectId: string;
  readonly prompt: string;
  readonly createdAt: string;
}

interface ConversationDraftsState {
  drafts: ConversationDraft[];
  addDraft: (draft: ConversationDraft) => void;
  /** Remove once the server durably accepted (or permanently rejected) it. */
  removeDraft: (requestId: string) => void;
  get: (requestId: string) => ConversationDraft | null;
  reset: () => void;
}

const MAX_DRAFTS = 50;

export const useConversationDrafts = create<ConversationDraftsState>((set, get) => ({
  drafts: [],

  addDraft: (draft) => {
    if (!draft.requestId || draft.prompt.trim().length === 0) return;
    set((s) => {
      if (s.drafts.some((d) => d.requestId === draft.requestId)) return s;
      const drafts = [...s.drafts, draft];
      // Bound the pending list; oldest first.
      return { drafts: drafts.length > MAX_DRAFTS ? drafts.slice(drafts.length - MAX_DRAFTS) : drafts };
    });
  },

  removeDraft: (requestId) => {
    set((s) => {
      if (!s.drafts.some((d) => d.requestId === requestId)) return s;
      return { drafts: s.drafts.filter((d) => d.requestId !== requestId) };
    });
  },

  get: (requestId) => get().drafts.find((d) => d.requestId === requestId) ?? null,

  reset: () => set({ drafts: [] }),
}));
