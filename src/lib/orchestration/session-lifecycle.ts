import { getPiClient } from "../pi/client";
import { useExtUi } from "../pi/ext-ui";
import type { PiState } from "../pi/protocol";
import { piRequestErrorText } from "../pi/request-error";
import { getPiStore } from "../pi/store";
import { t } from "../i18n";

export function getCurrentPiModel(taskId?: string): { provider: string; id: string } | null {
  const model = getPiStore(taskId ?? "").getState().currentModel;
  return model ? { provider: model.provider, id: model.id } : null;
}

/**
 * Ask pi for its current session file path for a specific task.
 *
 * pi's `get_state` RPC returns `sessionFile` (full .jsonl path) and `sessionId`
 * (UUID). Both are valid for `--session <path|id>` at process startup, which is
 * how context is restored on the next launch.
 */
export async function readCurrentPiSessionPath(taskId?: string): Promise<{
  path: string;
  failure: string;
}> {
  let failure = "";
  let path = "";
  try {
    const client = getPiClient(taskId);
    const response = await client.request<PiState>({ type: "get_state" });
    if (!response.success) {
      failure = response.error || "get_state failed";
    } else {
      path =
        response.data?.sessionFile ??
        response.data?.sessionId ??
        response.data?.sessionPath ??
        "";
    }
  } catch (error) {
    failure = piRequestErrorText(error);
  }
  return { path: path || getPiClient(taskId).lastSessionId, failure };
}

export async function syncPiSessionName(taskId: string, name: string): Promise<void> {
  try {
    const response = await getPiClient(taskId).request({
      type: "set_session_name",
      name,
    });
    if (!response.success) {
      useExtUi.getState().pushToast(
        t("session.renameSyncFailed", {
          error: response.error || t("agent.taskFailed"),
        }),
        "warning",
        6000
      );
    }
  } catch (error) {
    useExtUi.getState().pushToast(
      t("session.renameSyncFailed", {
        error: piRequestErrorText(error),
      }),
      "warning",
      6000
    );
  }
}