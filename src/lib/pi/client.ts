"use client";

import {
  type PiCommand,
  type PiEvent,
  type PiResponse,
  parsePiLine,
} from "./protocol";
import { getPort } from "../backend/composition/container";
import {
  DEFAULT_TASK_ID,
  type PiProcessExit,
  type PiProcessPort,
} from "../backend/ports/pi-process";
import { getActiveTaskId } from "./task-context";
import type { ExecutionBinding } from "../backend/ports/execution-target";

type EventCb = (e: PiEvent) => void;
/** Cross-task listener — receives the originating task id alongside the event. */
type AnyTaskEventCb = (taskId: string, e: PiEvent) => void;

export type PiRequestErrorKind = "send" | "timeout" | "exit" | "stopped";

interface PiRequestErrorOptions {
  kind: PiRequestErrorKind;
  command: string;
  requestId: string;
  detail?: string;
  timeoutMs?: number;
  exitCode?: number | null;
}

/** A request failed before Pi confirmed that it had accepted the command. */
export class PiRequestError extends Error {
  readonly kind: PiRequestErrorKind;
  readonly command: string;
  readonly requestId: string;
  readonly detail?: string;
  readonly timeoutMs?: number;
  readonly exitCode?: number | null;

  constructor(options: PiRequestErrorOptions) {
    const suffix = options.detail ? `: ${options.detail}` : "";
    super(`pi rpc ${options.kind} (${options.command}, ${options.requestId})${suffix}`);
    this.name = "PiRequestError";
    this.kind = options.kind;
    this.command = options.command;
    this.requestId = options.requestId;
    this.detail = options.detail;
    this.timeoutMs = options.timeoutMs;
    this.exitCode = options.exitCode;
  }
}

interface PendingRequest {
  command: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (response: PiResponse) => void;
  reject: (error: PiRequestError) => void;
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function exitCode(exit: PiProcessExit): number | null {
  return exit.code ?? null;
}

export class PiClient {
  readonly process: PiProcessPort;
  /**
   * The task (conversation) this client belongs to. Carried on the instance so
   * every event can be attributed to its task on the cross-task bus below —
   * consumers that must see *all* tasks (extension UI) need to know which
   * process to answer.
   */
  readonly taskId: string;
  private seq = 0;
  private pending = new Map<string, PendingRequest>();
  private subs = new Map<string, Set<EventCb>>();
  private anySubs = new Set<EventCb>();
  private stderrSubs = new Set<(line: string) => void>();
  private exitSubs = new Set<(code: number | null) => void>();
  private started = false;
  private readonly unlisten: Array<() => void> = [];

  /**
   * The session id from pi's most recent `session` event. Captured here so it is
   * never missed, regardless of when consumers register listeners.
   */
  lastSessionId = "";

  constructor(taskId: string, process: PiProcessPort) {
    this.taskId = taskId;
    this.process = process;
    this.unlisten.push(
      this.process.onLine((line) => this.handleLine(line)),
      this.process.onStderr((line) => this.stderrSubs.forEach((listener) => listener(line))),
      this.process.onExit((exit) => {
        this.started = false;
        const code = exitCode(exit);
        this.rejectPending("exit", undefined, code);
        this.exitSubs.forEach((listener) => listener(code));
      })
    );
  }

  private rejectPending(
    kind: "exit" | "stopped",
    detail?: string,
    code?: number | null
  ) {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new PiRequestError({
          kind,
          command: pending.command,
          requestId,
          detail,
          exitCode: code,
        })
      );
    }
    this.pending.clear();
  }

  private handleLine(line: string) {
    const ev = parsePiLine(line);
    if (!ev) return;
    if (ev.type === "session" && ev.id) this.lastSessionId = ev.id;
    if (ev.type === "response" && ev.id && this.pending.has(ev.id)) {
      const pending = this.pending.get(ev.id)!;
      this.pending.delete(ev.id);
      clearTimeout(pending.timer);
      pending.resolve(ev as PiResponse);
    }
    this.subs.get(ev.type)?.forEach((cb) => cb(ev));
    this.anySubs.forEach((cb) => cb(ev));
    dispatchAnyTask(this.taskId, ev);
  }

  async start(opts: { cwd?: string; resumePath?: string; executionBinding?: ExecutionBinding } = {}) {
    if (this.started) return;
    await this.process.start(opts);
    this.started = true;
  }

  /** fire-and-forget */
  send(cmd: PiCommand) {
    void this.process.send(cmd).catch((error) => {
      const line = `Pi RPC send failed (${cmd.type}): ${errorDetail(error)}`;
      this.stderrSubs.forEach((listener) => listener(line));
    });
  }

  /**
   * Write a command and report whether the *write* succeeded — no response
   * correlation.
   *
   * For commands pi answers, use `request`. Some it deliberately does not:
   * `extension_ui_response` is intercepted by pi's stdin dispatcher, which
   * resolves the waiting extension promise and returns before reaching
   * `handleCommand`, so no `response` is ever emitted. Correlating one would
   * hang until the timeout — and `extension_ui_response.id` is the dialog's id,
   * not an RPC id, so it does not belong in the correlation table either.
   */
  async write(cmd: PiCommand): Promise<void> {
    try {
      await this.process.send(cmd);
    } catch (error) {
      throw new PiRequestError({
        kind: "send",
        command: cmd.type,
        requestId: (cmd as { id?: string }).id ?? "-",
        detail: errorDetail(error),
      });
    }
  }

  /**
   * Request with response correlation via id.
   *
   * A caller-supplied `id` is preserved because pi echoes it on out-of-band
   * events too (`bash_execution_update.id`).
   */
  request<T = unknown>(cmd: PiCommand, timeoutMs = 15_000): Promise<PiResponse<T>> {
    const given = (cmd as { id?: unknown }).id;
    const id = typeof given === "string" && given ? given : `req-${++this.seq}`;
    const withId = { ...cmd, id } as PiCommand & { id: string };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new PiRequestError({
            kind: "timeout",
            command: cmd.type,
            requestId: id,
            timeoutMs,
          })
        );
      }, timeoutMs);
      this.pending.set(id, {
        command: cmd.type,
        timer,
        resolve: (response) => resolve(response as PiResponse<T>),
        reject,
      });
      void this.process.send(withId).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(
          new PiRequestError({
            kind: "send",
            command: cmd.type,
            requestId: id,
            detail: errorDetail(error),
          })
        );
      });
    });
  }

  on(type: PiEvent["type"] | string, cb: EventCb): () => void {
    if (!this.subs.has(type)) this.subs.set(type, new Set());
    this.subs.get(type)!.add(cb);
    return () => this.subs.get(type)?.delete(cb);
  }

  onAny(cb: EventCb): () => void {
    this.anySubs.add(cb);
    return () => this.anySubs.delete(cb);
  }

  onStderr(cb: (line: string) => void): () => void {
    this.stderrSubs.add(cb);
    return () => this.stderrSubs.delete(cb);
  }

  onExit(cb: (code: number | null) => void): () => void {
    this.exitSubs.add(cb);
    return () => this.exitSubs.delete(cb);
  }

  async stop() {
    await this.process.stop();
    this.started = false;
    this.rejectPending("stopped", "Pi was stopped before acknowledging the request");
  }

  dispose() {
    void this.stop().catch(() => undefined);
    while (this.unlisten.length > 0) this.unlisten.pop()?.();
    this.subs.clear();
    this.anySubs.clear();
    this.stderrSubs.clear();
    this.exitSubs.clear();
  }
}

/* ── cross-task event bus ──────────────────────────────────────────────────
 * `on()` binds to one client, which is right for anything scoped to a single
 * conversation. Extension UI is not: pi blocks a turn on `ui.select`/`editor`
 * until the harness answers, so a request from *any* task must reach the sheet
 * or that task hangs forever. Subscribing at the module level means a consumer
 * cannot miss clients created after it started, which is the failure a
 * boot-time `getPiClient()` (no task id, resolves to `"default"`) produced.
 */
const anyTaskSubs = new Map<string, Set<AnyTaskEventCb>>();

function dispatchAnyTask(taskId: string, e: PiEvent) {
  anyTaskSubs.get(e.type)?.forEach((cb) => cb(taskId, e));
}

/**
 * Subscribe to one event type across every task, present and future. Prefer
 * `getPiClient(taskId).on(...)` unless the consumer genuinely spans tasks.
 */
export function onAnyTaskEvent(
  type: PiEvent["type"] | string,
  cb: AnyTaskEventCb
): () => void {
  if (!anyTaskSubs.has(type)) anyTaskSubs.set(type, new Set());
  anyTaskSubs.get(type)!.add(cb);
  return () => {
    const set = anyTaskSubs.get(type);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) anyTaskSubs.delete(type);
  };
}

const disposeSubs = new Set<(taskId: string) => void>();

/**
 * Notified when a task's client goes away (project switch, deleted session).
 * Cross-task consumers use this to drop state they were holding for that task —
 * an unanswered dialog whose process is gone can never be answered.
 */
export function onPiClientDisposed(cb: (taskId: string) => void): () => void {
  disposeSubs.add(cb);
  return () => disposeSubs.delete(cb);
}

/**
 * One `PiClient` per task id — each owns its own pi process via a task-scoped
 * port, so parallel conversations stream into their own clients. A client
 * survives process restarts (the port is re-spawned), so the request/response
 * correlation tables stay valid across `restart`.
 */
const clients = new Map<string, PiClient>();

function resolveTaskId(taskId?: string): string {
  const given = (taskId ?? "").trim();
  if (given) return given;
  const active = getActiveTaskId().trim();
  return active || DEFAULT_TASK_ID;
}

/**
 * The client for a task (defaults to the currently focused conversation).
 * Lazily creates a task-scoped process port on first use.
 */
export function getPiClient(
  taskId?: string,
  executionBinding?: ExecutionBinding,
 ): PiClient {
  const key = resolveTaskId(taskId);
  let client = clients.get(key);
  if (!client) {
    client = new PiClient(key, getPort("createPiProcess")(key, executionBinding));
    clients.set(key, client);
  }
  return client;
}

/**
 * The client for a task **without** creating one. Use this when answering
 * something the task sent us: if its client is already gone, spawning a fresh
 * pi process just to write a reply nobody is waiting for is worse than dropping
 * the reply.
 */
export function peekPiClient(taskId: string): PiClient | undefined {
  return clients.get(taskId.trim() || DEFAULT_TASK_ID);
}

/** Tear down a specific task's client (used when switching projects). */
export function disposePiClient(taskId: string): void {
  const key = taskId.trim() || DEFAULT_TASK_ID;
  const client = clients.get(key);
  if (!client) return;
  client.dispose();
  clients.delete(key);
  disposeSubs.forEach((cb) => cb(key));
}

/** Tear down every task's client (app shutdown / project switch). */
export function disposeAllPiClients(): void {
  const keys = [...clients.keys()];
  for (const client of clients.values()) client.dispose();
  clients.clear();
  for (const key of keys) disposeSubs.forEach((cb) => cb(key));
}

export function configurePiClientForTests(process: PiProcessPort): PiClient {
  resetPiClientForTests();
  const key = resolveTaskId();
  const client = new PiClient(key, process);
  clients.set(key, client);
  return client;
}

export function resetPiClientForTests(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
  // `anyTaskSubs` / `disposeSubs` are intentionally left alone. A cross-task
  // subscription is owned by whoever registered it (ext-ui subscribes once for
  // the app's lifetime and guards re-entry), so clearing it here would silently
  // detach a live consumer with no way to re-attach — exactly the failure this
  // bus exists to prevent.
}
