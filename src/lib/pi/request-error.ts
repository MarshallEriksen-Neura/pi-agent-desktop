"use client";

import { t } from "../i18n";
import { PiRequestError } from "./client";

/** Turn a rejected Pi RPC request into a concrete, user-facing explanation. */
export function piRequestErrorText(error: unknown): string {
  if (error instanceof PiRequestError) {
    switch (error.kind) {
      case "send":
        return t("agent.piSendFailed", {
          command: error.command,
          id: error.requestId,
          reason: error.detail || error.message,
        });
      case "timeout":
        return t("agent.piAckTimeout", {
          command: error.command,
          id: error.requestId,
          seconds: String(Math.ceil((error.timeoutMs ?? 0) / 1000)),
        });
      case "exit":
        return t("agent.piRequestExited", {
          command: error.command,
          id: error.requestId,
          code:
            typeof error.exitCode === "number"
              ? String(error.exitCode)
              : t("common.unknown"),
        });
      case "stopped":
        return t("agent.piRequestStopped", {
          command: error.command,
          id: error.requestId,
        });
    }
  }

  return t("agent.piRequestFailed", {
    reason: error instanceof Error ? error.message : String(error),
  });
}
