import type { RemoteConversationsPort } from "../ports";

/** Browser preview starts with no remote devices or conversations. */
export const mockRemoteConversationsPort: RemoteConversationsPort = {
  list: async () => [],
  get: async () => {
    throw new Error("remote conversation was not found");
  },
  messages: async (conversationId) => ({ conversationId, messages: [] }),
  append: async () => {
    throw new Error("remote conversation was not found");
  },
  cancel: async () => false,
  archive: async () => false,
};
