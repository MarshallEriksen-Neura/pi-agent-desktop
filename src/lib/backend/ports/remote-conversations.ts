import type {
  RemoteConversationSnapshot,
  RemoteMessagePageResponse,
  RemoteTurnAppendResponse,
} from "@pi/remote-control-contracts";

/** Local desktop access to the gateway-owned remote conversation domain. */
export interface RemoteConversationsPort {
  list(limit?: number): Promise<readonly RemoteConversationSnapshot[]>;
  get(conversationId: string): Promise<RemoteConversationSnapshot>;
  messages(
    conversationId: string,
    afterOrdinal?: number,
    limit?: number,
  ): Promise<RemoteMessagePageResponse>;
  append(
    conversationId: string,
    prompt: string,
    requestId: string,
    modelRef?: string,
  ): Promise<RemoteTurnAppendResponse>;
  cancel(conversationId: string, turnId: string): Promise<boolean>;
  archive(conversationId: string): Promise<boolean>;
}
