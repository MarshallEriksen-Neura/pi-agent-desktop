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

type EventCb = (e: PiEvent) => void;

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

  constructor(process: PiProcessPort) {
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
  }

  async start(opts: { cwd?: string; resumePath?: string } = {}) {
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
export function getPiClient(taskId?: string): PiClient {
  const key = resolveTaskId(taskId);
  let client = clients.get(key);
  if (!client) {
    client = new PiClient(getPort("createPiProcess")(key));
    clients.set(key, client);
  }
  return client;
}

/** Tear down a specific task's client (used when switching projects). */
export function disposePiClient(taskId: string): void {
  const key = taskId.trim() || DEFAULT_TASK_ID;
  const client = clients.get(key);
  if (!client) return;
  client.dispose();
  clients.delete(key);
}

/** Tear down every task's client (app shutdown / project switch). */
export function disposeAllPiClients(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
}

export function configurePiClientForTests(process: PiProcessPort): PiClient {
  resetPiClientForTests();
  const client = new PiClient(process);
  clients.set(resolveTaskId(), client);
  return client;
}

export function resetPiClientForTests(): void {
  for (const client of clients.values()) client.dispose();
  clients.clear();
}
