import type { ChatMessage } from "../../pi/chat";
import type { ChatSessionMeta, TrashedSessionMeta } from "../../pi/sessions";

export interface SessionSaveInput extends ChatSessionMeta {
  messages: ChatMessage[];
  /** Keep the existing history ordering for read-only/native hydration writes. */
  preserveUpdatedAt?: boolean;
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
  /** Read Pi's authoritative local JSONL without starting a Pi RPC process. */
  readNativeTranscript(scope: SessionScope, path: string): Promise<string | null>;
  save(scope: SessionScope, session: SessionSaveInput): Promise<void>;
  rename(scope: SessionScope, id: string, name: string): Promise<void>;
  delete(scope: SessionScope, id: string): Promise<void>;
  listTrash(scope: SessionScope): Promise<TrashedSessionMeta[]>;
  restoreTrash(scope: SessionScope, tombstoneId: number): Promise<void>;
  purgeTrash(scope: SessionScope, tombstoneId: number): Promise<void>;
  generateTitle(input: GenerateTitleInput): Promise<string>;
}
