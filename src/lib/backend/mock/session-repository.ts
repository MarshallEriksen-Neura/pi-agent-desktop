import type { SessionRepositoryPort, SessionSaveInput } from "../ports";
import type { ChatMessage } from "../../pi/chat";
import type { ChatSessionMeta } from "../../pi/sessions";

interface StoredSession extends ChatSessionMeta {
  messages: ChatMessage[];
}

export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LS_KEY = "pi-desktop.chat-sessions";

export function createMockSessionRepositoryPort(
  storage: SessionStorageLike | null =
    typeof localStorage === "undefined" ? null : localStorage
): SessionRepositoryPort {
  let memory: StoredSession[] = [];

  function read(): StoredSession[] {
    if (!storage) return memory;
    try {
      const raw = storage.getItem(LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  function write(all: StoredSession[]) {
    if (!storage) {
      memory = all;
      return;
    }
    try {
      storage.setItem(LS_KEY, JSON.stringify(all));
    } catch {
      memory = all;
    }
  }

  return {
    list: async (projectRoot: string) =>
      read()
        .filter((session) => session.projectRoot === projectRoot)
        .map(({ messages: _messages, ...meta }) => meta)
        .sort((a, b) => b.updatedAt - a.updatedAt),

    load: async (id: string) => read().find((session) => session.id === id)?.messages ?? [],

    save: async (session: SessionSaveInput) => {
      const rest = read().filter((item) => item.id !== session.id);
      write([{ ...session, updatedAt: Date.now() }, ...rest]);
    },

    rename: async (id: string, name: string) => {
      write(read().map((session) => (session.id === id ? { ...session, name } : session)));
    },

    delete: async (id: string) => {
      write(read().filter((session) => session.id !== id));
    },

    // Browser preview has no pi process, so there is no transcript on disk to move.
    trashSessionFile: async () => {},

    generateTitle: async () => "",
  };
}

export const mockSessionRepositoryPort = createMockSessionRepositoryPort();
