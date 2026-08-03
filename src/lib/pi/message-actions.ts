"use client";

import { getPiClient } from "./client";
import { useExtUi } from "./ext-ui";
import { piRequestErrorText } from "./request-error";
import { t } from "../i18n";

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
      useExtUi.getState().pushToast(t("message.forkUnavailable"), "warning");
      return;
    }
    void (async () => {
      try {
        const response = await getPiClient().request({ type: "fork", entryId });
        if (!response.success) {
          useExtUi.getState().pushToast(
            t("message.forkFailed", {
              error: response.error || t("agent.taskFailed"),
            }),
            "error",
            6000
          );
        }
      } catch (error) {
        useExtUi.getState().pushToast(piRequestErrorText(error), "error", 6000);
      }
    })();
  };

  return { copyMarkdown, fork };
}
