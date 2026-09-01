"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, Plug, Server, Square } from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import type { RemoteTaskReport } from "@/lib/backend/ports/remote-profiles";
import {
  canStopRemoteTask,
  deriveRemoteConnectionState,
  isReattachable,
  type RemoteConnectionState,
} from "@/lib/pi/remote-connection-state";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useSessions } from "@/lib/pi/sessions";
import { usePi } from "@/lib/pi/store";
import { useT } from "@/lib/i18n";

/**
 * The state of a detached remote task, and the two actions it needs.
 *
 * Exists because the desktop previously had one notion of "connected", which cannot
 * express a detached task: the channel and the work have separate lifetimes. Closing the
 * attach is not stopping the task, and a task can be running with nothing attached.
 *
 * The `lost` state is the one this is really for. It means *we do not know* — the local
 * transport gave up at a measured 24.2s while a partitioned pi keeps running until sshd's
 * 7200s keepalive notices, so anything that displayed a guess would be wrong for up to two
 * hours. The only way out is to ask the host, which is what Check does.
 */
export function RemoteTaskBadge() {
  const t = useT();
  const binding = useSessions((state) => state.executionBinding);
  const status = usePi((state) => state.status);
  const [report, setReport] = useState<RemoteTaskReport | undefined>();
  const [busy, setBusy] = useState<"check" | "stop" | null>(null);

  const remoteTaskId = binding.kind === "ssh" ? binding.remoteTaskId : null;
  const profileId = binding.kind === "ssh" ? binding.profileId : null;
  // A local `--attach` child is running exactly while pi's status is live.
  const channelOpen = status !== "disconnected";

  // A fresh channel makes any earlier report obsolete: it described a task nobody was
  // attached to, and now something is.
  useEffect(() => {
    if (channelOpen) setReport(undefined);
  }, [channelOpen]);

  const check = useCallback(async () => {
    if (!profileId || !remoteTaskId) return;
    setBusy("check");
    try {
      setReport(await getPort("remoteProfiles").taskStatus(profileId, remoteTaskId));
    } catch (error) {
      useExtUi.getState().pushToast(String(error), "error", 7000);
    } finally {
      setBusy(null);
    }
  }, [profileId, remoteTaskId]);

  if (!remoteTaskId || !profileId) return null;

  const state: RemoteConnectionState = deriveRemoteConnectionState({ channelOpen, report });
  const stopTask = async () => {
    setBusy("stop");
    try {
      const stopped = await getPort("remoteProfiles").stopTask(profileId, remoteTaskId);
      setReport(stopped);
      useExtUi
        .getState()
        .pushToast(t("remoteAgent.task.stopped", { code: String(stopped.exitCode ?? "—") }), "info", 5000);
    } catch (error) {
      useExtUi.getState().pushToast(String(error), "error", 7000);
    } finally {
      setBusy(null);
    }
  };

  const tone = TONES[state];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 8px",
        borderRadius: 999,
        border: `1px solid ${tone}`,
        fontFamily: "var(--font-ui)",
        fontSize: 11,
        color: tone,
      }}
      title={t(`remoteAgent.task.${state}.hint`)}
    >
      {busy !== null ? (
        <LoaderCircle size={11} className="animate-spin" />
      ) : state === "lost" ? (
        <AlertTriangle size={11} />
      ) : state === "orphaned" ? (
        <Plug size={11} />
      ) : (
        <Server size={11} />
      )}
      <span>{t(`remoteAgent.task.${state}`)}</span>
      {/* Only offered when it would tell us something new. While the channel is open the
          answer is already visible, and asking would be a round trip for nothing. */}
      {!channelOpen && isReattachable(state) && (
        <button onClick={() => void check()} disabled={busy !== null} style={actionStyle}>
          {t("remoteAgent.task.check")}
        </button>
      )}
      {canStopRemoteTask(state) && (
        <button
          onClick={() => void stopTask()}
          disabled={busy !== null}
          title={t("remoteAgent.task.stopHint")}
          style={actionStyle}
        >
          <Square size={9} />
          {t("remoteAgent.task.stop")}
        </button>
      )}
    </div>
  );
}

/**
 * `orphaned` is not a warning colour on purpose: a task running with nothing attached is a
 * normal, recoverable state — reattaching is exactly what the cursor exists for. Only
 * `lost`, where the remote state is genuinely unknown, gets the warning tone.
 */
const TONES: Record<RemoteConnectionState, string> = {
  running: "var(--accent)",
  lost: "var(--warning)",
  exited: "var(--text-tertiary)",
  orphaned: "var(--accent)",
};

const actionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  padding: 0,
};
