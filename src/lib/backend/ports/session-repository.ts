import type { ChatMessage } from "../../pi/chat";
import type { ChatSessionMeta } from "../../pi/sessions";

export interface SessionSaveInput extends ChatSessionMeta {
  messages: ChatMessage[];
}

export interface GenerateTitleInput {
  prompt: string;
  provider: string | null;
  modelId: string | null;
  cwd: string | null;
}

export interface SessionRepositoryPort {
  list(projectRoot: string): Promise<ChatSessionMeta[]>;
  load(id: string): Promise<ChatMessage[]>;
  save(session: SessionSaveInput): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
  generateTitle(input: GenerateTitleInput): Promise<string>;
}
