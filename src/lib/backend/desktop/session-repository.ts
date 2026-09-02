import type {
  GenerateTitleInput,
  SessionRepositoryPort,
  SessionSaveInput,
} from "../ports";
import type { ChatMessage } from "../../pi/chat";
import type { ChatSessionMeta } from "../../pi/sessions";
import { decodeSessionMessages } from "../session-cache";
import { desktopInvoke } from "./invoke";

export const desktopSessionRepositoryPort: SessionRepositoryPort = {
  list: (scope) =>
    // spread, not `scope` itself: `desktopInvoke` takes a `Record<string, unknown>`
    // and an interface without an index signature is not assignable to one
    desktopInvoke<ChatSessionMeta[]>("chat_sessions_list", { ...scope }),

  load: async (scope, id): Promise<ChatMessage[]> => {
    const json = await desktopInvoke<string | null>("chat_session_load", { ...scope, id });
    if (!json) return [];
    return decodeSessionMessages(json);
  },

  save: (scope, session: SessionSaveInput) =>
    desktopInvoke<void>("chat_session_save", {
      targetKey: scope.targetKey,
      session: {
        id: session.id,
        name: session.name,
        sessionPath: session.sessionPath,
        preview: session.preview,
        projectRoot: session.projectRoot,
        executionBinding: session.executionBinding,
        authoritySessionId: session.authoritySessionId ?? null,
        source: session.source ?? "cache",
        messages: JSON.stringify(session.messages),
        createdAt: session.createdAt,
      },
    }),

  rename: (scope, id, name) =>
    desktopInvoke<void>("chat_session_rename", { ...scope, id, name }),

  delete: (scope, id) => desktopInvoke<void>("chat_session_delete", { ...scope, id }),

  trashSessionFile: (scope, path) =>
    desktopInvoke<void>("pi_session_trash", { path, projectRoot: scope.projectRoot }),

  generateTitle: (input: GenerateTitleInput) =>
    desktopInvoke<string>("pi_generate_title", {
      prompt: input.prompt,
      provider: input.provider,
      modelId: input.modelId,
      cwd: input.cwd,
    }),
};
