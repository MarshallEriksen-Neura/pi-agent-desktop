import type { ExecutionBinding } from "./execution-target";
import type { LocalTerminalShellProfile } from "../../terminal-shell-profile";

export interface RemoteTerminalStartOptions {
  sessionId: string;
  executionBinding: ExecutionBinding;
  /** Local-only working-directory snapshot. Omitted for SSH bindings. */
  cwd?: string | null;
  /** Local-only shell selection snapshot. Ignored for SSH bindings. */
  localShell?: LocalTerminalShellProfile | null;
  cols: number;
  rows: number;
}

export interface RemoteTerminalStartResult {
  sessionId: string;
  targetId: string;
  /** True when a custom local executable was rejected or failed and Auto was used. */
  shellFallback: boolean;
}

export interface RemoteTerminalData {
  sessionId: string;
  data: Uint8Array;
}

export interface RemoteTerminalExit {
  sessionId: string;
  code: number | null;
  signal: string | null;
  error: string | null;
}

export type RemoteTerminalUnlisten = () => void;

/** An interactive terminal transport, separate from Pi's JSONL RPC channel. */
export interface RemoteTerminalPort {
  start(options: RemoteTerminalStartOptions): Promise<RemoteTerminalStartResult>;
  write(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  stop(sessionId: string): Promise<void>;
  onData(handler: (event: RemoteTerminalData) => void): Promise<RemoteTerminalUnlisten>;
  onExit(handler: (event: RemoteTerminalExit) => void): Promise<RemoteTerminalUnlisten>;
}

export function createUnsupportedRemoteTerminalPort(): RemoteTerminalPort {
  const unsupported = async (): Promise<never> => {
    throw new Error("Remote terminals are unavailable in browser preview.");
  };
  return {
    start: unsupported,
    write: unsupported,
    resize: unsupported,
    stop: unsupported,
    onData: async () => () => {},
    onExit: async () => () => {},
  };
}
