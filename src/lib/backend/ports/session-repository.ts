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
  /**
   * Move pi's own transcript for a conversation into the session trash.
   *
   * Deliberately separate from `delete`, because the two halves of removing a
   * conversation fail differently: losing the index row is the outcome the user
   * asked for, while failing to move the transcript only leaves an orphan on
   * disk — which is where every conversation deleted before this existed already
   * left things. Callers delete the row first and treat this as best effort.
   */
  trashSessionFile(path: string): Promise<void>;
  generateTitle(input: GenerateTitleInput): Promise<string>;
}
