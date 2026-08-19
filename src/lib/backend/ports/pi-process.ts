import type { PiCommand, PiEvent } from "../../pi/protocol";

/** Task key used when the caller omits `taskId` — the primary conversation. */
export const DEFAULT_TASK_ID = "default";

export interface PiProcessStartOptions {
  cwd?: string;
  resumePath?: string;
  taskId?: string;
}

export interface PiProcessExit {
  code: number | null;
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
