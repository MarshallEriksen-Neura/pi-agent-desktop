import { listen } from "@tauri-apps/api/event";
import type {
  RemoteTerminalData,
  RemoteTerminalExit,
  RemoteTerminalPort,
  RemoteTerminalStartOptions,
  RemoteTerminalStartResult,
} from "../ports/remote-terminal";
import { desktopInvoke } from "./invoke";

interface DataPayload {
  sessionId: string;
  generation: number;
  dataBase64: string;
}

interface ExitPayload {
  sessionId: string;
  generation: number;
  code: number | null;
  signal: string | null;
  error: string | null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isDataPayload(value: unknown): value is DataPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DataPayload).sessionId === "string" &&
    Number.isSafeInteger((value as DataPayload).generation) &&
    (value as DataPayload).generation > 0 &&
    typeof (value as DataPayload).dataBase64 === "string"
  );
}

function isExitPayload(value: unknown): value is ExitPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as ExitPayload;
  return (
    typeof payload.sessionId === "string" &&
    Number.isSafeInteger(payload.generation) &&
    payload.generation > 0 &&
    (payload.code === null || typeof payload.code === "number") &&
    (payload.signal === null || typeof payload.signal === "string") &&
    (payload.error === null || typeof payload.error === "string")
  );
}

interface DesktopRemoteTerminalDependencies {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(
    event: string,
    handler: (event: { payload: T }) => void
  ): Promise<() => void>;
}

const defaultDependencies: DesktopRemoteTerminalDependencies = {
  invoke: desktopInvoke,
  listen,
};

export class DesktopRemoteTerminalPort implements RemoteTerminalPort {
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();
  private readonly stoppingSessions = new Set<string>();
  private readonly stopPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly dependencies: DesktopRemoteTerminalDependencies = defaultDependencies
  ) {}
  async start(options: RemoteTerminalStartOptions): Promise<RemoteTerminalStartResult> {
    const pendingStop = this.stopPromises.get(options.sessionId);
    if (pendingStop) await pendingStop;
    const generation = (this.generations.get(options.sessionId) ?? 0) + 1;
    this.generations.set(options.sessionId, generation);
    this.stoppingSessions.delete(options.sessionId);
    try {
      const result = await this.dependencies.invoke<RemoteTerminalStartResult>(
        "remote_terminal_start",
        {
          sessionId: options.sessionId,
          generation,
          executionBinding: options.executionBinding,
          cols: options.cols,
          rows: options.rows,
        }
      );
      if (
        this.generations.get(options.sessionId) !== generation ||
        this.stoppingSessions.has(options.sessionId)
      ) {
        await this.dependencies
          .invoke<void>("remote_terminal_stop", { sessionId: options.sessionId, generation })
          .catch(() => undefined);
        throw new Error("Remote terminal session stopped while starting.");
      }
      return result;
    } catch (error) {
      if (this.generations.get(options.sessionId) === generation) {
        this.stoppingSessions.add(options.sessionId);
      }
      await this.dependencies
        .invoke<void>("remote_terminal_stop", { sessionId: options.sessionId, generation })
        .catch(() => undefined);
      throw error;
    }
  }

  write(sessionId: string, data: string): Promise<void> {
    const generation = this.generations.get(sessionId) ?? 0;
    const previous = this.writeChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (
          this.stoppingSessions.has(sessionId) ||
          (this.generations.get(sessionId) ?? 0) !== generation
        ) {
          throw new Error("Remote terminal session is stopping.");
        }
        return this.dependencies.invoke<void>("remote_terminal_write", {
          sessionId,
          generation,
          data,
        });
      });
    this.writeChains.set(sessionId, next);
    const cleanup = () => {
      if (this.writeChains.get(sessionId) === next) this.writeChains.delete(sessionId);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    if (this.stoppingSessions.has(sessionId)) {
      return Promise.reject(new Error("Remote terminal session is stopping."));
    }
    const generation = this.generations.get(sessionId) ?? 0;
    return this.dependencies.invoke<void>("remote_terminal_resize", {
      sessionId,
      generation,
      cols,
      rows,
    });
  }

  stop(sessionId: string): Promise<void> {
    const existing = this.stopPromises.get(sessionId);
    if (existing) return existing;

    const generation = this.generations.get(sessionId) ?? 0;
    this.stoppingSessions.add(sessionId);
    const stopping = this.dependencies
      .invoke<void>("remote_terminal_stop", { sessionId, generation })
      .then(
        () => {
          if (this.generations.get(sessionId) === generation) {
            this.generations.set(sessionId, generation + 1);
          }
        },
        (error) => {
          if (this.generations.get(sessionId) === generation) {
            this.stoppingSessions.delete(sessionId);
          }
          throw error;
        }
      );
    this.stopPromises.set(sessionId, stopping);
    const cleanup = () => {
      if (this.stopPromises.get(sessionId) === stopping) this.stopPromises.delete(sessionId);
    };
    void stopping.then(cleanup, cleanup);
    return stopping;
  }

  async onData(handler: (event: RemoteTerminalData) => void) {
    return this.dependencies.listen<unknown>("remote-terminal://data", (event) => {
      if (!isDataPayload(event.payload)) return;
      if (this.generations.get(event.payload.sessionId) !== event.payload.generation) return;
      try {
        handler({
          sessionId: event.payload.sessionId,
          data: decodeBase64(event.payload.dataBase64),
        });
      } catch (error) {
        console.error("Invalid remote terminal output:", error);
      }
    });
  }

  async onExit(handler: (event: RemoteTerminalExit) => void) {
    return this.dependencies.listen<unknown>("remote-terminal://exit", (event) => {
      if (!isExitPayload(event.payload)) return;
      if (this.generations.get(event.payload.sessionId) !== event.payload.generation) return;
      handler({
        sessionId: event.payload.sessionId,
        code: event.payload.code,
        signal: event.payload.signal,
        error: event.payload.error,
      });
    });
  }
}

export const desktopRemoteTerminalPort: RemoteTerminalPort = new DesktopRemoteTerminalPort();
