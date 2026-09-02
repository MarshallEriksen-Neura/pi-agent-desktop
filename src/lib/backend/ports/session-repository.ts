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

export interface SessionScope {
  /** Stable authority namespace (for example `local` or `ssh:<profileId>`). */
  targetKey: string;
  /** Canonical project/cwd key within that authority. */
  projectRoot: string;
}

export interface SessionRepositoryPort {
  list(scope: SessionScope): Promise<ChatSessionMeta[]>;
  load(scope: SessionScope, id: string): Promise<ChatMessage[]>;
  save(scope: SessionScope, session: SessionSaveInput): Promise<void>;
  rename(scope: SessionScope, id: string, name: string): Promise<void>;
  delete(scope: SessionScope, id: string): Promise<void>;
  /**
   * Move pi's own transcript for a conversation into the session trash.
   *
   * Deliberately separate from `delete`, because the two halves of removing a
   * conversation fail differently: losing the index row is the outcome the user
   * asked for, while failing to move the transcript only leaves an orphan on
   * disk — which is where every conversation deleted before this existed already
   * left things. Callers delete the row first and treat this as best effort.
   */
  trashSessionFile(scope: SessionScope, path: string): Promise<void>;
  generateTitle(input: GenerateTitleInput): Promise<string>;
}
