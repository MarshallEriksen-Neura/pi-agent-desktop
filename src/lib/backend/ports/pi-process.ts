import type { PiCommand, PiEvent } from "../../pi/protocol";
import type { ExecutionBinding } from "./execution-target";

/** Task key used when the caller omits `taskId` — the primary conversation. */
export const DEFAULT_TASK_ID = "default";

export interface PiProcessStartOptions {
  cwd?: string;
  resumePath?: string;
  taskId?: string;
  /** Execution target is immutable for the lifetime of the process port. */
  executionBinding?: ExecutionBinding;
  /**
   * Detached remote bindings only: resume the journal after this sequence.
   *
   * The caller's cursor — only it knows what it has already applied. Omitted replays
   * from the oldest record still retained, which is what a fresh attach wants.
   */
  attachAfter?: number;
}

export interface PiProcessExit {
  code: number | null;
  /**
   * Why a detached attach channel ended.
   *
   * Absent on a local or attached-remote exit, where the channel ending *is* pi
   * exiting. On a detached target the two are different events, and only
   * `taskExited` means pi is gone — `caughtUp` and `taskGone` are the channel's own
   * outcomes, and a lost channel produces no frame at all.
   */
  detachReason?: "taskExited" | "caughtUp" | "taskGone";
}

export interface PiProcessPort {
  /** Owning task id — events are filtered to this task's process. */
  readonly taskId: string;
  start(options?: PiProcessStartOptions): Promise<void>;
  send(command: PiCommand): Promise<void>;
  stop(): Promise<void>;
  onLine(handler: (line: string) => void): () => void;
  onStderr(handler: (line: string) => void): () => void;
  onExit(handler: (exit: PiProcessExit) => void): () => void;
}

export type PiProcessEvent = PiEvent;
