import type { PiCommand, PiEvent } from "../../pi/protocol";

export interface PiProcessStartOptions {
  cwd?: string;
  resumePath?: string;
}

export interface PiProcessExit {
  code: number | null;
}

export interface PiProcessPort {
  start(options?: PiProcessStartOptions): Promise<void>;
  send(command: PiCommand): Promise<void>;
  stop(): Promise<void>;
  onLine(handler: (line: string) => void): () => void;
  onStderr(handler: (line: string) => void): () => void;
  onExit(handler: (exit: PiProcessExit) => void): () => void;
}

export type PiProcessEvent = PiEvent;
