import { getPiClient } from "../pi/client";
import { useExtUi } from "../pi/ext-ui";
import type { PiState } from "../pi/protocol";
import { piRequestErrorText } from "../pi/request-error";
import { usePi } from "../pi/store";
import { t } from "../i18n";

export interface SessionLifecycleDeps {
  projectRoot: () => string;
  syncSessionPath: () => void;
}

export function getCurrentPiModel(): { provider: string; id: string } | null {
  const model = usePi.getState().currentModel;
  return model ? { provider: model.provider, id: model.id } : null;
}

export async function resetPiConversation(
  projectRoot: string,
  syncSessionPath: () => void,
  restartForProject = false
): Promise<boolean> {
  if (restartForProject) {
    try {
      await usePi.getState().restart(projectRoot || undefined);
      syncSessionPath();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      usePi.setState({ status: "disconnected", lastError: detail });
      useExtUi.getState().pushToast(
        t("session.projectSwitchFailed", { error: detail }),
        "error",
        9000
      );
      return false;
    }
  }

  let firstFailure = "";
  try {
    const response = await getPiClient().request({ type: "new_session" });
    if (!response.success) {
      firstFailure = response.error || t("agent.taskFailed");
      throw new Error(firstFailure);
    }
    syncSessionPath();
    return true;
  } catch (error) {
    firstFailure ||= piRequestErrorText(error);
  }

  try {
    await usePi.getState().restart(projectRoot || undefined);
    useExtUi.getState().pushToast(
      t("session.newRecovered", { error: firstFailure }),
      "warning",
      7000
    );
    syncSessionPath();
    return true;
  } catch (error) {
    const restartFailure = error instanceof Error ? error.message : String(error);
    usePi.setState({ status: "disconnected", lastError: restartFailure });
    useExtUi.getState().pushToast(
      t("session.newFailed", {
        error: `${firstFailure} · ${restartFailure}`,
      }),
      "error",
      9000
    );
    return false;
  }
}

export async function restartPiForRestoredSession(
  projectRoot: string | undefined,
  sessionPath: string
): Promise<boolean> {
  try {
    await usePi.getState().restart(projectRoot, sessionPath);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usePi.setState({ status: "disconnected", lastError: detail });
    useExtUi.getState().pushToast(
      t("session.restoreFailedDetailed", { error: detail }),
      "error",
      9000
    );
    return false;
  }
}

export async function restartPiForProjectSwitch(
  projectRoot: string,
  sessionPath?: string
): Promise<boolean> {
  try {
    await usePi.getState().restart(projectRoot, sessionPath);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    usePi.setState({ status: "disconnected", lastError: detail });
    useExtUi.getState().pushToast(
      t("session.projectSwitchFailed", { error: detail }),
      "error",
      9000
    );
    return false;
  }
}

export async function readCurrentPiSessionPath(): Promise<{
  path: string;
  failure: string;
}> {
  let failure = "";
  let path = "";
  try {
    const response = await getPiClient().request<PiState>({ type: "get_state" });
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
  return { path: path || getPiClient().lastSessionId, failure };
}

export async function syncPiSessionName(name: string): Promise<void> {
  try {
    const response = await getPiClient().request({
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
