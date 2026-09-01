/**
 * Attach-frame decoding for detached remote tasks (RAV2 V2.2).
 *
 * `--attach` is shaped like `--run` — one ssh child whose stdout is a stream of
 * lines — so it drops into the existing `pi://line` plumbing. The difference is that
 * each line is a frame wrapping a journal record rather than a raw pi line. This
 * module is the only place that knows the difference: it unwraps frames, tracks the
 * cursor a reconnect needs, and hands the caller exactly the pi lines it would have
 * seen from an attached run.
 *
 * Contract: docs/remote-agent-v2-session-recovery.md.
 */

/** Why a channel closed. `taskExited` is the only one that means pi is gone. */
export type AttachDetachReason = "taskExited" | "caughtUp" | "taskGone";

export interface AttachHandshake {
  type: "attached";
  remoteTaskId: string;
  state: "starting" | "running" | "stopping" | "exited";
  after: number | null;
  baseSequence: number;
  nextSequence: number;
  snapshotRequired: boolean;
  pid: number | null;
  supervisorPid: number | null;
}

export interface AttachEvent {
  type: "event";
  sequence: number;
  ts: number | null;
  stream: "stdout" | "stderr" | "control";
  /** Raw pi line for `stdout`/`stderr`; absent on control records. */
  data?: string;
  /** Set when the record was cut at the launcher's per-event byte cap. */
  truncated?: boolean;
  /** Launcher-owned event name on `control` records. */
  event?: string;
  exitCode?: number | null;
  exitSignal?: string | null;
}

export interface AttachGap {
  type: "gap";
  fromSequence: number;
  toSequence: number;
}

export interface AttachDetached {
  type: "detached";
  reason: AttachDetachReason;
  exitCode: number | null;
  nextSequence: number;
}

/** A failure reply, which every launcher task mode reports the same way. */
export interface AttachFailure {
  ok: false;
  errorCode: string;
  detail?: string;
}

export type AttachFrame =
  | AttachHandshake
  | AttachEvent
  | AttachGap
  | AttachDetached
  | AttachFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isSequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Parses one line of attach stdout. Returns `null` for anything unrecognised rather
 * than throwing: a launcher newer than this build may add frame types, and dropping
 * one unknown line must not tear down a live channel.
 */
export function parseAttachFrame(line: string): AttachFrame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  // A failure is the same `{ok:false,errorCode}` shape every task mode uses, so
  // success is distinguished by the presence of `type`.
  if (parsed.ok === false) {
    return typeof parsed.errorCode === "string"
      ? {
          ok: false,
          errorCode: parsed.errorCode,
          ...(typeof parsed.detail === "string" ? { detail: parsed.detail } : {}),
        }
      : null;
  }
  switch (parsed.type) {
    case "attached":
      return isSequence(parsed.baseSequence) && isSequence(parsed.nextSequence)
        ? (parsed as unknown as AttachHandshake)
        : null;
    case "event":
      return isSequence(parsed.sequence) &&
        (parsed.stream === "stdout" || parsed.stream === "stderr" || parsed.stream === "control")
        ? (parsed as unknown as AttachEvent)
        : null;
    case "gap":
      return isSequence(parsed.fromSequence) && isSequence(parsed.toSequence)
        ? (parsed as unknown as AttachGap)
        : null;
    case "detached":
      return parsed.reason === "taskExited" ||
        parsed.reason === "caughtUp" ||
        parsed.reason === "taskGone"
        ? (parsed as unknown as AttachDetached)
        : null;
    default:
      return null;
  }
}

/** What the caller must do with one decoded frame. */
export interface AttachStep {
  /** Raw pi JSONL lines to feed the chat pipeline, in order. */
  lines: string[];
  /** stderr lines, which pi uses for diagnostics only. */
  diagnostics: string[];
  /**
   * The transcript is incomplete from here: either the cursor was outside the
   * retained window at attach, or records were evicted mid-stream. The caller must
   * discard what it has and rebuild from what follows.
   */
  resetTranscript: boolean;
  /** Present once the channel has closed; pi is gone only on `taskExited`. */
  detached?: AttachDetached;
  /** Present when the launcher refused the attach outright. */
  failure?: AttachFailure;
}

const EMPTY_STEP: AttachStep = Object.freeze({
  lines: Object.freeze([]) as unknown as string[],
  diagnostics: Object.freeze([]) as unknown as string[],
  resetTranscript: false,
});

/**
 * Tracks the cursor a reconnect needs.
 *
 * `sequence` is the *only* thing a reattach has to remember, and it must survive the
 * local process generation: every reattach opens a new ssh child, so filtering
 * replayed events by generation would drop all of them. Feed each stdout line here
 * and pass `appliedSequence` back as the next attach's `after`.
 */
export function createAttachCursor(initialSequence = 0) {
  let applied = initialSequence;
  let closed: AttachDetached | undefined;

  return {
    /** Highest sequence handed to the caller, and therefore safe to resume after. */
    get appliedSequence(): number {
      return applied;
    },
    get detached(): AttachDetached | undefined {
      return closed;
    },
    accept(line: string): AttachStep {
      const frame = parseAttachFrame(line);
      if (!frame) return EMPTY_STEP;
      if ("ok" in frame) return { ...EMPTY_STEP, failure: frame };
      if (frame.type === "attached") {
        // Reported in the handshake rather than as its own event: one place to look
        // beats an ordering rule. Consumes no sequence space, so a retry with the
        // same stale cursor gets the same answer.
        return { ...EMPTY_STEP, resetTranscript: frame.snapshotRequired };
      }
      if (frame.type === "gap") {
        applied = Math.max(applied, frame.toSequence);
        return { ...EMPTY_STEP, resetTranscript: true };
      }
      if (frame.type === "detached") {
        closed = frame;
        return { ...EMPTY_STEP, detached: frame };
      }
      // Never move the cursor backwards: a duplicate replay after a reconnect is
      // possible, and rewinding would resend everything after it a second time.
      if (frame.sequence <= applied) return EMPTY_STEP;
      applied = frame.sequence;
      if (frame.stream === "stdout" && typeof frame.data === "string") {
        return { ...EMPTY_STEP, lines: [frame.data] };
      }
      if (frame.stream === "stderr" && typeof frame.data === "string") {
        return { ...EMPTY_STEP, diagnostics: [frame.data] };
      }
      return EMPTY_STEP;
    },
  };
}
