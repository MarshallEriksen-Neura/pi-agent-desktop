import type { RemoteConversationsPort } from "../ports";
import type {
  RemoteConversationSnapshot,
  RemoteMessagePageResponse,
  RemoteTurnAppendResponse,
} from "@pi/remote-control-contracts";
import { desktopInvoke } from "./invoke";

export const desktopRemoteConversationsPort: RemoteConversationsPort = {
  list: (limit) =>
    desktopInvoke<RemoteConversationSnapshot[]>("remote_conversations_list", {
      limit: limit ?? null,
    }),
  get: (conversationId) =>
    desktopInvoke<RemoteConversationSnapshot>("remote_conversation_get", {
      conversationId,
    }),
  messages: (conversationId, afterOrdinal, limit) =>
    desktopInvoke<RemoteMessagePageResponse>("remote_conversation_messages", {
      conversationId,
      afterOrdinal: afterOrdinal ?? null,
      limit: limit ?? null,
    }),
  append: (conversationId, prompt, requestId, modelRef) =>
    desktopInvoke<RemoteTurnAppendResponse>("remote_conversation_append", {
      conversationId,
      prompt,
      requestId,
      modelRef: modelRef ?? null,
    }),
  cancel: (conversationId, turnId) =>
    desktopInvoke<boolean>("remote_conversation_cancel", {
      conversationId,
      turnId,
    }),
  archive: (conversationId) =>
    desktopInvoke<boolean>("remote_conversation_archive", { conversationId }),
};
