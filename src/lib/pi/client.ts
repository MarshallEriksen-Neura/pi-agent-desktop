"use client";

import {
  type PiCommand,
  type PiEvent,
  type PiResponse,
  type PiModel,
  parsePiLine,
} from "./protocol";

/* ────────────────────────────────────────────────────────────────────────────
   Transport abstraction — the client speaks JSONL lines; where those lines go
   (a real `pi --mode rpc` process via Tauri, or a browser mock) is pluggable.
   ──────────────────────────────────────────────────────────────────────────── */

export interface Transport {
  readonly kind: "tauri" | "mock";
  start(opts: { cwd?: string; binary?: string; resumePath?: string }): Promise<void>;
  send(line: string): void;
  onLine(cb: (line: string) => void): () => void;
  /** pi stderr (errors, stack traces, crash logs) */
  onStderr(cb: (line: string) => void): () => void;
  /** pi process exited (crashed or stopped) with the exit code */
  onExit(cb: (code: number) => void): () => void;
  stop(): Promise<void>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ── Tauri transport: Rust spawns pi, stdout lines arrive as events ── */

class TauriTransport implements Transport {
  readonly kind = "tauri" as const;
  private listeners = new Set<(line: string) => void>();
  private stderrListeners = new Set<(line: string) => void>();
  private exitListeners = new Set<(code: number) => void>();
  private unlisten: (() => void) | null = null;
  private unlistenStderr: (() => void) | null = null;
  private unlistenExit: (() => void) | null = null;

  async start(opts: { cwd?: string; binary?: string; resumePath?: string }) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    this.unlisten = await listen<string>("pi://line", (e) => {
      this.listeners.forEach((l) => l(e.payload));
    });
    this.unlistenStderr = await listen<string>("pi://stderr", (e) => {
      this.stderrListeners.forEach((l) => l(e.payload));
    });
    this.unlistenExit = await listen<number>("pi://exit", (e) => {
      this.exitListeners.forEach((l) => l(e.payload));
    });
    await invoke("pi_start", {
      cwd: opts.cwd ?? null,
      binary: opts.binary ?? null,
      resumePath: opts.resumePath ?? null,
    });
  }

  send(line: string) {
    import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("pi_send", { line })
    );
  }

  onLine(cb: (line: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStderr(cb: (line: string) => void) {
    this.stderrListeners.add(cb);
    return () => this.stderrListeners.delete(cb);
  }

  onExit(cb: (code: number) => void) {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  async stop() {
    this.unlisten?.();
    this.unlistenStderr?.();
    this.unlistenExit?.();
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pi_stop");
  }
}

/* ── Mock transport: browser dev without a pi process ── */

const MOCK_MODELS: PiModel[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, reasoning: true },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000, reasoning: true },
  { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_000_000, reasoning: true },
  { provider: "zai", id: "glm-4.7", name: "GLM-4.7", contextWindow: 200_000 },
];

class MockTransport implements Transport {
  readonly kind = "mock" as const;
  private listeners = new Set<(line: string) => void>();
  private model: PiModel = MOCK_MODELS[1];
  private agentActive = false;

  async start() {
    this.emit({
      type: "session",
      version: 3,
      id: "mock-session",
      timestamp: new Date().toISOString(),
      cwd: "/mock/workspace",
    });
  }

  private emit(obj: unknown) {
    const line = JSON.stringify(obj);
    // async like a real pipe
    setTimeout(() => this.listeners.forEach((l) => l(line)), 8);
  }

  private respond(cmd: { type: string; id?: string }, data?: unknown, error?: string) {
    this.emit({
      type: "response",
      command: cmd.type,
      success: !error,
      id: cmd.id,
      data,
      error,
    } satisfies PiResponse);
  }

  send(line: string) {
    let cmd: PiCommand & { id?: string };
    try {
      cmd = JSON.parse(line);
    } catch {
      return;
    }
    switch (cmd.type) {
      case "get_available_models":
        this.respond(cmd, { models: MOCK_MODELS });
        break;
      case "get_state":
        this.respond(cmd, { model: this.model, thinkingLevel: "medium" });
        break;
      case "set_model": {
        const m = MOCK_MODELS.find(
          (x) => x.provider === cmd.provider && x.id === cmd.modelId
        );
        if (m) {
          this.model = m;
          this.respond(cmd, { model: m });
        } else this.respond(cmd, undefined, "Model not found");
        break;
      }
      case "set_thinking_level":
        this.respond(cmd, { level: cmd.level });
        break;
      case "get_commands":
        this.respond(cmd, {
          commands: [
            { name: "review", description: "Review current changes", source: "extension:pi-review" },
            { name: "web", description: "Search the web", source: "extension:web-search" },
            { name: "todos", description: "Manage session todos", source: "extension:todos" },
          ],
        });
        break;
      case "prompt": {
        const msg = (cmd as { message?: string }).message?.toLowerCase() ?? "";

        // ── error-path injection (browser testing of the failure surfaces) ──
        // `err-timeout` deliberately never acks so PiClient.request() hits its
        // own 15s timer — that is the whole point of the case, so it must be
        // checked before respond().
        if (msg.includes("err-timeout")) return;

        this.respond(cmd);

        if (msg.includes("err-model")) {
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          setTimeout(() => {
            this.emit({
              type: "message_update",
              assistantMessageEvent: {
                type: "error",
                reason: "error",
                message: "400 invalid_request_error: prompt is too long (210k > 200k tokens)",
              },
            });
            this.agentActive = false;
          }, 400);
          break;
        }

        if (msg.includes("err-ext")) {
          setTimeout(() => {
            this.emit({
              type: "extension_error",
              extensionPath: "/home/user/.pi/extensions/pi-review.ts",
              event: "tool_call",
              error: "TypeError: Cannot read properties of undefined (reading 'diff')",
            });
            // an extension blowing up does not kill the run — settle it so the
            // composer does not sit spinning in the mock
            this.emit({ type: "agent_settled" });
          }, 300);
          break;
        }

        if (msg.includes("err-retry")) {
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          setTimeout(() => {
            this.emit({
              type: "auto_retry_start",
              attempt: 1,
              maxAttempts: 3,
              delayMs: 2000,
              errorMessage: "529 overloaded_error: Overloaded",
            });
          }, 300);
          setTimeout(() => {
            this.emit({
              type: "auto_retry_end",
              success: false,
              attempt: 3,
              finalError: "429 rate_limit_error: retry budget exhausted",
            });
            this.emit({ type: "agent_settled" });
            this.agentActive = false;
          }, 2200);
          break;
        }

        if (msg.includes("err-compact")) {
          setTimeout(() => {
            this.emit({ type: "compaction_start", reason: "threshold" });
          }, 200);
          setTimeout(() => {
            this.emit({ type: "compaction_end", result: null, aborted: true });
          }, 900);
          setTimeout(() => {
            this.emit({
              type: "compaction_end",
              result: null,
              aborted: false,
              errorMessage: "API quota exceeded",
            });
            // compaction is out-of-band from the turn — settle so the mock
            // composer does not spin after the two toasts land
            this.emit({ type: "agent_settled" });
          }, 1600);
          break;
        }

        this.agentActive = true;
        this.emit({ type: "agent_start" });
        this.emit({ type: "turn_start" });

        // subagent fan-out preview — emits the real `subagent` tool shape so the
        // deck's details.results[] parsing is exercised without the extension
        if (msg.includes("subagent")) {
          this.simulateSubagent();
          break;
        }

        // keyword-triggered extension UI simulation (browser testing)
        if (msg.includes("confirm") || msg.includes("approve")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "confirm",
              title: "pi-review",
              message: "Apply suggested refactor to runAgentLoop()?",
            });
          }, 400);
        } else if (msg.includes("select") || msg.includes("choose")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "select",
              title: "Choose a branch strategy",
              options: ["rebase onto main", "merge main", "create feature branch"],
            });
          }, 400);
        } else if (msg.includes("input")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "input",
              title: "Commit message",
              placeholder: "feat: …",
            });
          }, 400);
        } else if (msg.includes("notify")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "notify",
              message: "Index refreshed — 1,204 symbols",
              notifyType: "info",
            });
          }, 400);
        } else if (msg.includes("timeout")) {
          // dialog with a timeout — pi auto-resolves its side, the sheet
          // should disappear on its own instead of waiting for a click
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "select",
              title: "Allow dangerous command?",
              message: "rm -rf ./build — auto-blocks in 6s",
              options: ["Allow", "Block"],
              timeout: 6000,
            });
          }, 400);
        } else if (msg.includes("status")) {
          // two keys at once, then one of them clears — exercises the map
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "setStatus",
              statusKey: "pi-review",
              statusText: "Turn 3 running…",
            });
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}-b`,
              method: "setStatus",
              statusKey: "indexer",
              statusText: "1,204 symbols",
            });
          }, 400);
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "setStatus",
              statusKey: "pi-review",
            }); // no statusText → clears that key only
          }, 6000);
        } else if (msg.includes("widget")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "setWidget",
              widgetKey: "todos",
              widgetLines: ["── todos ──", "☑ wire ext surfaces", "☐ verify build"],
              widgetPlacement: "aboveEditor",
            });
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}-b`,
              method: "setWidget",
              widgetKey: "hint",
              widgetLines: ["tip: /review before commit"],
              widgetPlacement: "belowEditor",
            });
          }, 400);
        } else if (msg.includes("title")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "setTitle",
              title: "pi — ragcode-pi",
            });
          }, 400);
        } else if (msg.includes("prefill")) {
          setTimeout(() => {
            this.emit({
              type: "extension_ui_request",
              id: `ui-${Date.now()}`,
              method: "set_editor_text",
              text: "/review --staged",
            });
          }, 400);
        }

        // Simulate realistic agent execution with tool calls
        const toolId = `tc-${Date.now()}`;
        setTimeout(() => {
          this.emit({
            type: "tool_execution_start",
            toolCallId: toolId,
            toolName: "read",
            args: { path: "src/lib/agent.ts" },
          });
        }, 250);

        setTimeout(() => {
          this.emit({
            type: "tool_execution_end",
            toolCallId: toolId,
            result: "142 lines",
            isError: false,
          });

          this.emit({ type: "message_start" });
          const text =
            "(mock) pi is not connected — this is the browser preview stream. " +
            "Try prompts containing \"confirm\", \"select\", \"input\", \"notify\", " +
            "\"timeout\", \"status\", \"widget\", \"title\" or \"prefill\" to preview the " +
            "extension UI surfaces. Pet animation should respond to state changes.";
          let i = 0;
          const tick = () => {
            if (i < text.length) {
              const step = Math.min(3, text.length - i);
              this.emit({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: text.slice(i, i + step),
                },
              });
              i += step;
              setTimeout(tick, 24);
            } else {
              this.emit({ type: "message_end" });
              this.emit({ type: "turn_end" });
              this.emit({ type: "agent_end", messages: [{ role: "assistant", content: text }] });
              this.emit({ type: "agent_settled" });
              this.agentActive = false;
            }
          };
          tick();
        }, 850);
        break;
      }
      case "abort":
        this.respond(cmd);
        if (this.agentActive) {
          this.emit({ type: "agent_end" });
          this.emit({ type: "agent_settled" });
          this.agentActive = false;
        }
        break;
      case "bash": {
        // real pi streams incremental output as bash_execution_update events
        // (each echoing this command's id) and then returns the full BashResult
        // in the response — mirror both so the browser preview exercises the
        // same de-duplication path the Tauri build uses.
        const command = (cmd as { command?: string }).command ?? "";
        const lines = [
          `(mock shell) $ ${command}`,
          "pi is not connected — this is the browser preview.",
          "Run inside Tauri with pi installed for a real shell.",
          "",
        ];
        const output = lines.join("\n");
        lines.forEach((line, i) => {
          setTimeout(
            () =>
              this.emit({
                type: "bash_execution_update",
                id: cmd.id,
                delta: line + "\n",
              }),
            60 + i * 60
          );
        });
        setTimeout(
          () =>
            this.respond(cmd, {
              output,
              exitCode: 0,
              cancelled: false,
              truncated: false,
            }),
          60 + lines.length * 60 + 80
        );
        break;
      }
      case "abort_bash":
        this.respond(cmd);
        break;
      default:
        this.respond(cmd, {});
    }
  }

  /**
   * Browser preview of a `subagent` parallel fan-out. Mirrors the payload the
   * reference extension emits — `partialResult.details.results[]` with
   * `exitCode: -1` while a worker runs — so the deck's parsing can be exercised
   * without installing the extension.
   */
  private simulateSubagent() {
    const toolCallId = `tc-sub-${Date.now()}`;
    interface Worker {
      agent: string;
      agentSource: "user" | "project";
      task: string;
      model: string;
      steps: { name: string; args: Record<string, unknown> }[];
      answer: string;
      /** set to make this worker fail */
      error?: string;
    }
    const workers: Worker[] = [
      {
        agent: "scout",
        agentSource: "user",
        task: "Map the auth flow across the codebase",
        model: "claude-sonnet-4-5",
        steps: [
          { name: "grep", args: { pattern: "session|token" } },
          { name: "read", args: { path: "src/lib/auth/session.ts" } },
        ],
        answer: "entry → middleware → session.verify → rotate",
      },
      {
        agent: "reviewer",
        agentSource: "project",
        task: "Review the streaming diff patch",
        model: "claude-opus-4-8",
        steps: [{ name: "bash", args: { command: "git diff HEAD" } }],
        answer: "1 suggestion: await reason() lacks a timeout guard",
      },
      {
        agent: "worker",
        agentSource: "user",
        task: "Typecheck the workspace",
        model: "claude-sonnet-4-5",
        steps: [{ name: "bash", args: { command: "npx tsc --noEmit" } }],
        answer: "",
        error: "exit 1: tsc failed — 3 type errors in src/lib/agent.ts",
      },
    ];

    const zero = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    };
    const parts: Record<number, unknown[]> = {};
    const finished: Record<number, boolean> = {};
    workers.forEach((_, i) => {
      parts[i] = [];
    });

    /** the whole results array, rebuilt on every mutation (it is cumulative) */
    const snapshot = () =>
      workers.map((w, i) => {
        const done = finished[i] === true;
        const failed = done && Boolean(w.error);
        return {
          agent: w.agent,
          agentSource: w.agentSource,
          task: w.task,
          exitCode: done ? (w.error ? 1 : 0) : -1, // -1 = still running
          messages: parts[i].length > 0 ? [{ role: "assistant", content: parts[i] }] : [],
          stderr: failed ? w.error : "",
          usage: done
            ? {
                input: 12_000 + i * 2_000,
                output: 800 + i * 150,
                cacheRead: 6_000,
                cacheWrite: 900,
                cost: 0.03 + i * 0.01,
                contextTokens: 18_000 + i * 3_000,
                turns: w.steps.length + 1,
              }
            : zero,
          model: w.model,
          ...(failed ? { stopReason: "error", errorMessage: w.error } : {}),
        };
      });

    const details = () => ({
      mode: "parallel",
      agentScope: "user",
      projectAgentsDir: null,
      results: snapshot(),
    });

    const emitUpdate = () => {
      const results = snapshot();
      const done = results.filter((r) => r.exitCode !== -1).length;
      this.emit({
        type: "tool_execution_update",
        toolCallId,
        toolName: "subagent",
        partialResult: {
          content: [
            {
              type: "text",
              text: `Parallel: ${done}/${results.length} done, ${results.length - done} running...`,
            },
          ],
          details: details(),
        },
      });
    };

    this.emit({
      type: "tool_execution_start",
      toolCallId,
      toolName: "subagent",
      args: { tasks: workers.map((w) => ({ agent: w.agent, task: w.task })) },
    });

    // all workers are seeded up front, then each reports its own steps
    setTimeout(emitUpdate, 300);
    let settleAt = 0;
    workers.forEach((w, i) => {
      w.steps.forEach((s, j) => {
        setTimeout(
          () => {
            parts[i].push({ type: "toolCall", name: s.name, arguments: s.args });
            emitUpdate();
          },
          400 + i * 300 + j * 700
        );
      });
      const at = 400 + i * 300 + w.steps.length * 700 + 500;
      settleAt = Math.max(settleAt, at);
      setTimeout(() => {
        parts[i].push({ type: "text", text: w.error ?? w.answer });
        finished[i] = true;
        emitUpdate();
      }, at);
    });

    setTimeout(() => {
      const results = snapshot();
      const ok = results.filter((r) => r.exitCode === 0).length;
      this.emit({
        type: "tool_execution_end",
        toolCallId,
        toolName: "subagent",
        result: {
          content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded` }],
          details: details(),
        },
        isError: false,
      });
      this.emit({ type: "message_start" });
      this.emit({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta:
            `(mock) fanned out to ${workers.length} subagents — ${ok} succeeded. ` +
            "Tap a card to open its timeline.",
        },
      });
      this.emit({ type: "message_end" });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end" });
      this.emit({ type: "agent_settled" });
      this.agentActive = false;
    }, settleAt + 400);
  }

  onLine(cb: (line: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStderr(cb: (line: string) => void) {
    // mock transport never emits stderr
    return () => {};
  }

  onExit(cb: (code: number) => void) {
    // mock transport never exits
    return () => {};
  }

  async stop() {
    this.listeners.clear();
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   PiClient — request/response correlation + typed event subscription
   ──────────────────────────────────────────────────────────────────────────── */

type EventCb = (e: PiEvent) => void;

export class PiClient {
  readonly transport: Transport;
  private seq = 0;
  private pending = new Map<string, (r: PiResponse) => void>();
  private subs = new Map<string, Set<EventCb>>();
  private anySubs = new Set<EventCb>();
  private stderrSubs = new Set<(line: string) => void>();
  private exitSubs = new Set<(code: number) => void>();
  private started = false;

  constructor(transport?: Transport) {
    this.transport =
      transport ?? (isTauri() ? new TauriTransport() : new MockTransport());
    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onStderr((line) => this.stderrSubs.forEach((l) => l(line)));
    this.transport.onExit((code) => {
      this.exitSubs.forEach((l) => l(code));
    });
  }

  private handleLine(line: string) {
    const ev = parsePiLine(line);
    if (!ev) return;
    if (ev.type === "response" && ev.id && this.pending.has(ev.id)) {
      this.pending.get(ev.id)!(ev as PiResponse);
      this.pending.delete(ev.id);
    }
    this.subs.get(ev.type)?.forEach((cb) => cb(ev));
    this.anySubs.forEach((cb) => cb(ev));
  }

  async start(opts: { cwd?: string; binary?: string; resumePath?: string } = {}) {
    if (this.started) return;
    await this.transport.start(opts);
    this.started = true;
  }

  /** fire-and-forget */
  send(cmd: PiCommand) {
    this.transport.send(JSON.stringify(cmd));
  }

  /**
   * Request with response correlation via id.
   *
   * A caller-supplied `id` is preserved rather than replaced: pi echoes it on
   * out-of-band events too (`bash_execution_update.id`), so overwriting it would
   * break the caller's own correlation.
   */
  request<T = unknown>(cmd: PiCommand, timeoutMs = 15_000): Promise<PiResponse<T>> {
    const given = (cmd as { id?: unknown }).id;
    const id = typeof given === "string" && given ? given : `req-${++this.seq}`;
    const withId = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi rpc timeout: ${cmd.type}`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r as PiResponse<T>);
      });
      this.transport.send(JSON.stringify(withId));
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

  /** subscribe to pi stderr lines (errors, stack traces) */
  onStderr(cb: (line: string) => void): () => void {
    this.stderrSubs.add(cb);
    return () => this.stderrSubs.delete(cb);
  }

  /** subscribe to pi process exit (crash / unexpected stop) */
  onExit(cb: (code: number) => void): () => void {
    this.exitSubs.add(cb);
    return () => this.exitSubs.delete(cb);
  }

  async stop() {
    this.started = false;
    await this.transport.stop();
  }
}

/* singleton for the app */
let client: PiClient | null = null;
export function getPiClient(): PiClient {
  if (!client) client = new PiClient();
  return client;
}
