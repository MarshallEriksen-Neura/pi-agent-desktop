import { listen } from "@tauri-apps/api/event";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../ports/pi-process";
import { DEFAULT_TASK_ID } from "../ports/pi-process";
import { desktopInvoke } from "./invoke";
import type { PiCommand } from "../../pi/protocol";

type Unlisten = () => void;

/** Payload shape of the `pi://line` / `pi://stderr` events. */
interface PiLineEventPayload {
  taskId: string;
  line: string;
}

/** Payload shape of the `pi://exit` event. */
interface PiExitEventPayload {
  taskId: string;
  code: number | null;
}

function isLinePayload(value: unknown): value is PiLineEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PiLineEventPayload).taskId === "string" &&
    typeof (value as PiLineEventPayload).line === "string"
  );
}

function isExitPayload(value: unknown): value is PiExitEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PiExitEventPayload).taskId === "string"
  );
}

export class DesktopPiProcessPort implements PiProcessPort {
  readonly taskId: string;
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(exit: PiProcessExit) => void>();
  private unlistenLine: Unlisten | null = null;
  private unlistenStderr: Unlisten | null = null;
  private unlistenExit: Unlisten | null = null;

  constructor(taskId = DEFAULT_TASK_ID) {
    this.taskId = taskId;
  }

  async start(options: PiProcessStartOptions = {}): Promise<void> {
    await this.ensureListeners();
    await desktopInvoke("pi_start", {
      taskId: this.taskId,
      cwd: options.cwd ?? null,
      binary: null,
      resumePath: options.resumePath ?? null,
    });
  }

  async send(command: PiCommand): Promise<void> {
    await desktopInvoke("pi_send", {
      taskId: this.taskId,
      line: JSON.stringify(command),
    });
  }

  async stop(): Promise<void> {
    await desktopInvoke("pi_stop", { taskId: this.taskId });
    this.cleanupListeners();
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return once(() => {
      this.lineHandlers.delete(handler);
    });
  }

  onStderr(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return once(() => {
      this.stderrHandlers.delete(handler);
    });
  }

  onExit(handler: (exit: PiProcessExit) => void): () => void {
    this.exitHandlers.add(handler);
    return once(() => {
      this.exitHandlers.delete(handler);
    });
  }

  private async ensureListeners(): Promise<void> {
    if (!this.unlistenLine) {
      this.unlistenLine = await listen<unknown>("pi://line", (event) => {
        const payload = event.payload;
        if (!isLinePayload(payload) || payload.taskId !== this.taskId) return;
        this.lineHandlers.forEach((handler) => handler(payload.line));
      });
    }
    if (!this.unlistenStderr) {
      this.unlistenStderr = await listen<unknown>("pi://stderr", (event) => {
        const payload = event.payload;
        if (!isLinePayload(payload) || payload.taskId !== this.taskId) return;
        this.stderrHandlers.forEach((handler) => handler(payload.line));
      });
    }
    if (!this.unlistenExit) {
      this.unlistenExit = await listen<unknown>("pi://exit", (event) => {
        const payload = event.payload;
        if (!isExitPayload(payload) || payload.taskId !== this.taskId) return;
        this.cleanupListeners();
        this.exitHandlers.forEach((handler) =>
          handler({ code: payload.code ?? null })
        );
      });
    }
  }

  private cleanupListeners(): void {
    this.unlistenLine?.();
    this.unlistenStderr?.();
    this.unlistenExit?.();
    this.unlistenLine = null;
    this.unlistenStderr = null;
    this.unlistenExit = null;
  }
}

export function createDesktopPiProcessPort(taskId = DEFAULT_TASK_ID): PiProcessPort {
  return new DesktopPiProcessPort(taskId);
}

function once(cleanup: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}