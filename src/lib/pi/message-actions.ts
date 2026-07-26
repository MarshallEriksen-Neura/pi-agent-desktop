"use client";

import { getPiClient } from "./client";

export interface MessageActions {
  copyMarkdown: () => Promise<void>;
  fork: () => void;
}

/**
 * Message-level actions hook — returns handlers for copy and fork operations.
 *
 * @param messageContent - The markdown content to copy
 * @param entryId - The entry ID for fork operations (optional, from protocol)
 */
export function useMessageActions(
  messageContent: string,
  entryId?: string
): MessageActions {
  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(messageContent);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  };

  const fork = () => {
    if (!entryId) {
      console.warn("Cannot fork: no entryId available");
      return;
    }
    getPiClient().send({ type: "fork", entryId });
  };

  return { copyMarkdown, fork };
}
