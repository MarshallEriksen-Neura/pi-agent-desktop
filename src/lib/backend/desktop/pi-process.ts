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
import { createAttachCursor } from "../../pi/remote-attach";

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

/**
 * A key for one outbound message, matching the launcher's `[A-Za-z0-9_.-]{1,128}`.
 *
 * Monotonic counter plus a per-process random prefix: the counter alone would collide
 * across desktop restarts against a task that outlived one, and the launcher treats a
 * repeated key with a *different* payload as a conflict rather than a retry.
 */
const KEY_PREFIX = Math.random().toString(36).slice(2, 10);
let keySequence = 0;
function nextIdempotencyKey(): string {
  keySequence += 1;
  return `k-${KEY_PREFIX}-${keySequence}`;
}

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
  | { kind: "line"; payload: PiLineEventPayload }
  | { kind: "stderr"; payload: PiLineEventPayload }
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
  private readonly transcriptResetHandlers = new Set<() => void>();
  /**
   * Non-null exactly when the child is `--attach`, i.e. a detached remote target.
   *
   * Created per start, because a reattach replays from a cursor the caller supplies and
   * the decoder has to begin counting from there rather than from zero.
   */
  private cursor: ReturnType<typeof createAttachCursor> | null = null;

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
    // The binding already carries the signal: `remoteTaskId` is present exactly when the
    // profile is detached, an invariant `validate_binding` enforces on the Rust side. So
    // the adapter needs no second source of truth for the lifecycle.
    const detached = binding.kind === "ssh" && Boolean(binding.remoteTaskId);
    this.targetId = targetIdForBinding(binding);
    this.generation = null;
    this.starting = true;
    this.pendingEvents = [];
    try {
      await this.ensureListeners();
      if (startStopEpoch !== this.stopEpoch) {
        throw new Error("Pi start was cancelled");
      }
      // A detached remote target speaks attach frames, so the decoder has to exist
      // before the first line can arrive. Seeded with the caller's cursor: it counts
      // forward from what has already been applied, not from zero.
      this.cursor = detached ? createAttachCursor(options.attachAfter ?? 0) : null;
      const started = await this.dependencies.invoke<PiStartResult>("pi_start", {
        taskId: this.taskId,
        cwd: options.cwd ?? null,
        binary: null,
        resumePath: options.resumePath ?? null,
        executionBinding: binding,
        attachAfter: options.attachAfter ?? null,
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
      // Only for a detached target: on any other transport the write either reaches pi's
      // stdin or throws, with no ambiguous middle state to protect against.
      //
      // Per *call* rather than per attempt is the point. A transport-level retry of this
      // same send has to reuse the key, because a disconnect leaves it unknown whether the
      // first attempt landed — retrying blind would duplicate a turn, and not retrying
      // would lose one. A caller deciding to send again is a different message and gets a
      // different key.
      idempotencyKey: this.cursor !== null ? nextIdempotencyKey() : null,
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
      // On a detached target the child is `--attach`, so a line is a frame wrapping a
      // journal record rather than raw pi JSONL. This is the only place that knows the
      // difference: everything downstream receives pi lines either way.
      if (this.cursor !== null) {
        const step = this.cursor.accept(event.payload.line);
        if (step.failure !== undefined) {
          // The launcher refused the attach outright. Reported as a channel end, since
          // that is what it is — and pointedly *not* as pi exiting.
          this.finishExit({ code: null });
          return;
        }
        if (step.resetTranscript) {
          this.transcriptResetHandlers.forEach((handler) => handler());
        }
        step.lines.forEach((line) => {
          this.lineHandlers.forEach((handler) => handler(line));
        });
        step.diagnostics.forEach((line) => {
          this.stderrHandlers.forEach((handler) => handler(line));
        });
        if (step.detached !== undefined) {
          this.finishExit({
            // Only `taskExited` carries pi's own code. The other two are the channel's
            // outcomes, and reporting a code for them would claim pi died when it did not.
            code: step.detached.reason === "taskExited" ? step.detached.exitCode : null,
            detachReason: step.detached.reason,
          });
        }
        return;
      }
      this.lineHandlers.forEach((handler) => handler(event.payload.line));
      return;
    }
    if (event.kind === "stderr") {
      this.stderrHandlers.forEach((handler) => handler(event.payload.line));
      return;
    }
    this.finishExit({ code: event.payload.code ?? null });
  }

  /**
   * The highest sequence handed to the chat pipeline, or `null` on a target that has no
   * journal.
   *
   * Survives the process generation on purpose: a reattach is a new generation against
   * the same remote task, so this is what makes replay resumable rather than repeated.
   */
  get appliedSequence(): number | null {
    return this.cursor?.appliedSequence ?? null;
  }

  /**
   * The transcript is incomplete from here — records were evicted before this attach
   * could read them, so the caller has to discard what it has and rebuild from what
   * follows.
   */
  onTranscriptReset(handler: () => void): () => void {
    this.transcriptResetHandlers.add(handler);
    return once(() => {
      this.transcriptResetHandlers.delete(handler);
    });
  }

  private finishExit(exit: PiProcessExit): void {
    this.generation = null;
    this.starting = false;
    this.pendingEvents = [];
    this.cleanupListeners();
    this.exitHandlers.forEach((handler) => handler(exit));
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