import { listen } from "@tauri-apps/api/event";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../ports/pi-process";
import { DEFAULT_TASK_ID } from "../ports/pi-process";
import type { ExecutionBinding } from "../ports/execution-target";
import { desktopInvoke } from "./invoke";
import type { PiCommand } from "../../pi/protocol";

type Unlisten = () => void;
type EventHandler = (event: { payload: unknown }) => void;

export interface DesktopPiProcessDependencies {
  listen(event: string, handler: EventHandler): Promise<Unlisten>;
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const DEFAULT_DEPENDENCIES: DesktopPiProcessDependencies = {
  listen: (event, handler) => listen<unknown>(event, handler),
  invoke: (command, args) => desktopInvoke(command, args),
};

/** Payload shape of the `pi://line` / `pi://stderr` events. */
interface PiLineEventPayload {
  taskId: string;
  generation: number;
  targetId: string;
  line: string;
}

/** Payload shape of the `pi://exit` event. */
interface PiExitEventPayload {
  taskId: string;
  generation: number;
  targetId: string;
  code: number | null;
}

interface PiStartResult {
  generation: number;
  targetId: string;
}

type PendingEvent =
  | { kind: "line" | "stderr"; payload: PiLineEventPayload }
  | { kind: "exit"; payload: PiExitEventPayload };

function isLinePayload(value: unknown): value is PiLineEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PiLineEventPayload).taskId === "string" &&
    typeof (value as PiLineEventPayload).generation === "number" &&
    typeof (value as PiLineEventPayload).targetId === "string" &&
    typeof (value as PiLineEventPayload).line === "string"
  );
}

function isExitPayload(value: unknown): value is PiExitEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PiExitEventPayload).taskId === "string" &&
    typeof (value as PiExitEventPayload).generation === "number" &&
    typeof (value as PiExitEventPayload).targetId === "string"
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
  private generation: number | null = null;
  private targetId = "local";
  private starting = false;
  private stopEpoch = 0;
  private startOperation: Promise<void> | null = null;
  private pendingEvents: PendingEvent[] = [];

  constructor(
    taskId = DEFAULT_TASK_ID,
    private readonly executionBinding?: ExecutionBinding,
    private readonly dependencies: DesktopPiProcessDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.taskId = taskId;
  }

  async start(options: PiProcessStartOptions = {}): Promise<void> {
    if (this.startOperation) throw new Error("Pi is already starting");
    const operation = this.startInternal(options);
    this.startOperation = operation;
    try {
      await operation;
    } finally {
      if (this.startOperation === operation) this.startOperation = null;
    }
  }

  private async startInternal(options: PiProcessStartOptions): Promise<void> {
    const startStopEpoch = this.stopEpoch;
    const binding =
      options.executionBinding ?? this.executionBinding ?? { kind: "local", targetId: "local" };
    this.targetId = targetIdForBinding(binding);
    this.generation = null;
    this.starting = true;
    this.pendingEvents = [];
    try {
      await this.ensureListeners();
      if (startStopEpoch !== this.stopEpoch) {
        throw new Error("Pi start was cancelled");
      }
      const started = await this.dependencies.invoke<PiStartResult>("pi_start", {
        taskId: this.taskId,
        cwd: options.cwd ?? null,
        binary: null,
        resumePath: options.resumePath ?? null,
        executionBinding: binding,
      });
      if (started.targetId !== this.targetId) {
        await stopExpectedProcess(this.dependencies.invoke, this.taskId, started.generation, started.targetId).catch(
          () => undefined,
        );
        throw new Error(`Pi started on unexpected target ${started.targetId}`);
      }
      if (startStopEpoch !== this.stopEpoch) {
        await stopExpectedProcess(
          this.dependencies.invoke,
          this.taskId,
          started.generation,
          started.targetId,
        );
        throw new Error("Pi start was cancelled");
      }
      this.generation = started.generation;
      this.starting = false;
      const pending = this.pendingEvents;
      this.pendingEvents = [];
      pending.forEach((event) => this.dispatchEvent(event));
    } catch (error) {
      this.starting = false;
      this.pendingEvents = [];
      this.cleanupListeners();
      throw error;
    }
  }

  async send(command: PiCommand): Promise<void> {
    if (this.generation === null) throw new Error("Pi is not running");
    await this.dependencies.invoke("pi_send", {
      taskId: this.taskId,
      line: JSON.stringify(command),
      expectedGeneration: this.generation,
      expectedTargetId: this.targetId,
    });
  }

  async stop(): Promise<void> {
    this.stopEpoch += 1;
    const startOperation = this.startOperation;
    const generation = this.generation;
    const targetId = this.targetId;
    this.starting = false;
    this.generation = null;
    this.pendingEvents = [];
    this.cleanupListeners();
    try {
      if (generation !== null) {
        await stopExpectedProcess(this.dependencies.invoke, this.taskId, generation, targetId);
      }
    } finally {
      await startOperation?.catch(() => undefined);
    }
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
      this.unlistenLine = await this.dependencies.listen("pi://line", (event) => {
        const payload = event.payload;
        if (!isLinePayload(payload) || payload.taskId !== this.taskId) return;
        this.receiveEvent({ kind: "line", payload });
      });
    }
    if (!this.unlistenStderr) {
      this.unlistenStderr = await this.dependencies.listen("pi://stderr", (event) => {
        const payload = event.payload;
        if (!isLinePayload(payload) || payload.taskId !== this.taskId) return;
        this.receiveEvent({ kind: "stderr", payload });
      });
    }
    if (!this.unlistenExit) {
      this.unlistenExit = await this.dependencies.listen("pi://exit", (event) => {
        const payload = event.payload;
        if (!isExitPayload(payload) || payload.taskId !== this.taskId) return;
        this.receiveEvent({ kind: "exit", payload });
      });
    }
  }

  private receiveEvent(event: PendingEvent): void {
    if (event.payload.targetId !== this.targetId) return;
    if (this.starting) {
      this.pendingEvents.push(event);
      return;
    }
    this.dispatchEvent(event);
  }

  private dispatchEvent(event: PendingEvent): void {
    if (event.payload.generation !== this.generation) return;
    if (event.kind === "line") {
      this.lineHandlers.forEach((handler) => handler(event.payload.line));
      return;
    }
    if (event.kind === "stderr") {
      this.stderrHandlers.forEach((handler) => handler(event.payload.line));
      return;
    }
    this.generation = null;
    this.starting = false;
    this.pendingEvents = [];
    this.cleanupListeners();
    this.exitHandlers.forEach((handler) => handler({ code: event.payload.code ?? null }));
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

export function createDesktopPiProcessPort(
  taskId = DEFAULT_TASK_ID,
  executionBinding?: ExecutionBinding,
): PiProcessPort {
  return new DesktopPiProcessPort(taskId, executionBinding);
}
async function stopExpectedProcess(
  invoke: DesktopPiProcessDependencies["invoke"],
  taskId: string,
  expectedGeneration: number,
  expectedTargetId: string,
): Promise<void> {
  await invoke("pi_stop", { taskId, expectedGeneration, expectedTargetId });
}

function targetIdForBinding(binding: ExecutionBinding): string {
  return binding.kind === "ssh" ? `ssh:${binding.profileId}` : binding.targetId;
}

function once(cleanup: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}