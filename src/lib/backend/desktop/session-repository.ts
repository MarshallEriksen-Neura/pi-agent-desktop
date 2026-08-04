import type {
  GenerateTitleInput,
  SessionRepositoryPort,
  SessionSaveInput,
} from "../ports";
import type { ChatMessage } from "../../pi/chat";
import type { ChatSessionMeta } from "../../pi/sessions";
import { desktopInvoke } from "./invoke";

export const desktopSessionRepositoryPort: SessionRepositoryPort = {
  list: (projectRoot: string) =>
    desktopInvoke<ChatSessionMeta[]>("chat_sessions_list", { projectRoot }),

  load: async (id: string): Promise<ChatMessage[]> => {
    const json = await desktopInvoke<string | null>("chat_session_load", { id });
    if (!json) return [];
    try {
      const arr = JSON.parse(json);
      return Array.isArray(arr) ? (arr as ChatMessage[]) : [];
    } catch {
      return [];
    }
  },

  save: (session: SessionSaveInput) =>
    desktopInvoke<void>("chat_session_save", {
      session: {
        id: session.id,
        name: session.name,
        sessionPath: session.sessionPath,
        preview: session.preview,
        projectRoot: session.projectRoot,
        messages: JSON.stringify(session.messages),
        createdAt: session.createdAt,
      },
    }),

  rename: (id: string, name: string) =>
    desktopInvoke<void>("chat_session_rename", { id, name }),

  delete: (id: string) => desktopInvoke<void>("chat_session_delete", { id }),

  generateTitle: (input: GenerateTitleInput) =>
    desktopInvoke<string>("pi_generate_title", {
      prompt: input.prompt,
      provider: input.provider,
      modelId: input.modelId,
      cwd: input.cwd,
    }),
};
