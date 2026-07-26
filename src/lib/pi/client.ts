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
  start(opts: { cwd?: string; binary?: string }): Promise<void>;
  send(line: string): void;
  onLine(cb: (line: string) => void): () => void;
  stop(): Promise<void>;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ── Tauri transport: Rust spawns pi, stdout lines arrive as events ── */

class TauriTransport implements Transport {
  readonly kind = "tauri" as const;
  private listeners = new Set<(line: string) => void>();
  private unlisten: (() => void) | null = null;

  async start(opts: { cwd?: string; binary?: string }) {
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");
    this.unlisten = await listen<string>("pi://line", (e) => {
      this.listeners.forEach((l) => l(e.payload));
    });
    await invoke("pi_start", {
      cwd: opts.cwd ?? null,
      binary: opts.binary ?? null,
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

  async stop() {
    this.unlisten?.();
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
        this.respond(cmd);
        const msg = (cmd as { message?: string }).message?.toLowerCase() ?? "";
        this.agentActive = true;
        this.emit({ type: "agent_start" });
        this.emit({ type: "turn_start" });

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
            "Try prompts containing \"confirm\", \"select\", \"input\" or \"notify\" " +
            "to preview extension UI sheets. Pet animation should respond to state changes.";
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
        // real pi returns output in the response data (BashResult), no events
        const command = (cmd as { command?: string }).command ?? "";
        const output = [
          `(mock shell) $ ${command}`,
          "pi is not connected — this is the browser preview.",
          "Run inside Tauri with pi installed for a real shell.",
          "",
        ].join("\n");
        setTimeout(
          () =>
            this.respond(cmd, {
              output,
              exitCode: 0,
              cancelled: false,
              truncated: false,
            }),
          200
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

  onLine(cb: (line: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
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
  private started = false;

  constructor(transport?: Transport) {
    this.transport =
      transport ?? (isTauri() ? new TauriTransport() : new MockTransport());
    this.transport.onLine((line) => this.handleLine(line));
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

  async start(opts: { cwd?: string; binary?: string } = {}) {
    if (this.started) return;
    this.started = true;
    await this.transport.start(opts);
  }

  /** fire-and-forget */
  send(cmd: PiCommand) {
    this.transport.send(JSON.stringify(cmd));
  }

  /** request with response correlation via id */
  request<T = unknown>(cmd: PiCommand, timeoutMs = 15_000): Promise<PiResponse<T>> {
    const id = `req-${++this.seq}`;
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
