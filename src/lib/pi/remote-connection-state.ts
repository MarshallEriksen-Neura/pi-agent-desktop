import type { RemoteTaskReport } from "../backend/ports/remote-profiles";

/**
 * The four states a detached remote conversation can be in, and how they are derived.
 *
 * `status.json` reports **process** state, because that is all a launcher standing next to
 * pi can observe. These are **connection** states, and two of them are about the channel,
 * which only the desktop can see.
 *
 * | State | Meaning |
 * | --- | --- |
 * | `running` | channel open, task alive |
 * | `lost` | our transport gave up; remote state is **unknown and not inferable** |
 * | `exited` | confirmed dead, with or without a code |
 * | `orphaned` | task alive, but no channel of ours is attached to it |
 *
 * **`lost` and `orphaned` must stay distinct.** V1 collapsed them into one "unknown" and
 * then guessed — defect D2. The guess is wrong for up to ~2h: the local transport gives up
 * at a measured 24.2s while a partitioned pi keeps running until sshd's 7200s TCP
 * keepalive notices. So `lost` means *we do not know*, and the only way out of it is to
 * ask the host.
 */
export type RemoteConnectionState = "running" | "lost" | "exited" | "orphaned";

export interface RemoteConnectionInput {
  /** Is a local `--attach` child currently running for this conversation? */
  channelOpen: boolean;
  /**
   * Why the last attach ended, when it ended in a frame.
   *
   * A *missing* reason after the channel closed is the signal for `lost`: the launcher
   * always announces a deliberate end, so silence means the transport died mid-stream.
   */
  detachReason?: "taskExited" | "caughtUp" | "taskGone";
  /** The most recent `--status`, when one has been fetched since the channel closed. */
  report?: RemoteTaskReport;
}

export function deriveRemoteConnectionState(
  input: RemoteConnectionInput,
): RemoteConnectionState {
  if (input.channelOpen) return "running";

  // A reported end is authoritative about the *task*, so it beats a stale report.
  if (input.detachReason === "taskExited" || input.detachReason === "taskGone") return "exited";

  if (input.report !== undefined) {
    const { report } = input;
    if (!report.exists) return "exited";
    if (report.state === "exited") return "exited";
    // The host says the task is alive and nothing of ours is attached. That is precisely
    // `orphaned` — and it is a recoverable state, not an error: reattaching is what the
    // cursor exists for.
    return "orphaned";
  }

  // `caughtUp` closed the channel deliberately without saying anything about the task, so
  // the task's state is simply unobserved until someone asks.
  return "lost";
}

/** True when reattaching is the useful next action rather than starting over. */
export function isReattachable(state: RemoteConnectionState): boolean {
  return state === "lost" || state === "orphaned";
}

/**
 * Whether a stop request would reach anything.
 *
 * `lost` counts: the task may well be alive and unreachable-looking, and refusing to try
 * would leave a user with work running that they cannot stop.
 */
export function canStopRemoteTask(state: RemoteConnectionState): boolean {
  return state !== "exited";
}
