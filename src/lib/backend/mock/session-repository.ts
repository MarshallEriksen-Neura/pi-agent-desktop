import type { SessionRepositoryPort, SessionSaveInput, SessionScope } from "../ports";
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

function targetKey(session: ChatSessionMeta): string {
  const binding = session.executionBinding;
  return binding?.kind === "ssh" ? `ssh:${binding.profileId}` : "local";
}

function inScope(session: ChatSessionMeta, scope: SessionScope): boolean {
  return session.projectRoot === scope.projectRoot && targetKey(session) === scope.targetKey;
}

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
    } catch (error) {
      throw new Error(`Stored browser session index is corrupt: ${error instanceof Error ? error.message : String(error)}`);
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
    list: async (scope) =>
      read()
        .filter((session) => inScope(session, scope))
        .map(({ messages: _messages, ...meta }) => meta)
        .sort((a, b) => b.updatedAt - a.updatedAt),

    load: async (scope, id) =>
      read().find((session) => session.id === id && inScope(session, scope))?.messages ?? [],

    save: async (_scope, session: SessionSaveInput) => {
      const rest = read().filter((item) => item.id !== session.id);
      write([{ ...session, updatedAt: Date.now() }, ...rest]);
    },

    rename: async (scope, id, name) => {
      write(read().map((session) => (session.id === id && inScope(session, scope) ? { ...session, name } : session)));
    },

    delete: async (scope, id) => {
      write(read().filter((session) => session.id !== id || !inScope(session, scope)));
    },

    // Browser preview has no pi process, so there is no transcript on disk to move.
    trashSessionFile: async (_scope, _path) => {},

    generateTitle: async () => "",
  };
}

export const mockSessionRepositoryPort = createMockSessionRepositoryPort();
