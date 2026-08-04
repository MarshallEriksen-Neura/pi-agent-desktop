import type { PiCommand, PiModel, PiResponse } from "../../pi/protocol";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../ports/pi-process";

const MOCK_MODELS: PiModel[] = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, reasoning: true },
  { provider: "openai", id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000, reasoning: true },
  { provider: "google", id: "gemini-3-pro", name: "Gemini 3 Pro", contextWindow: 1_000_000, reasoning: true },
  { provider: "zai", id: "glm-4.7", name: "GLM-4.7", contextWindow: 200_000 },
];

export class MockPiProcessPort implements PiProcessPort {
  private listeners = new Set<(line: string) => void>();
  private model: PiModel = MOCK_MODELS[1];
  private agentActive = false;
  /** mid-turn messages waiting to be injected into the running turn */
  private steering: string[] = [];
  /** messages waiting for the current turn to end */
  private followUps: string[] = [];
  private nextCommandFailure: {
    command: string;
    mode: "error" | "timeout" | "send";
  } | null = null;
  private failNextStart = false;

  private started = false;
  private cwd = "/mock/workspace";

  async start(options: PiProcessStartOptions = {}): Promise<void> {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("mock pi_start failed: process spawn rejected");
    }
    this.started = true;
    this.cwd = options.cwd || "/mock/workspace";
    this.emit({
      type: "session",
      version: 3,
      id: options.resumePath || "mock-session",
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
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

  /** Emit a short successful assistant turn for browser-only fault arming. */
  private emitTextTurn(text: string) {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    };
    this.agentActive = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start", message: assistant });
    this.emit({
      type: "message_update",
      message: assistant,
      assistantMessageEvent: { type: "text_end", content: text },
    });
    this.emit({ type: "message_end", message: assistant });
    this.emit({ type: "agent_end", messages: [assistant], willRetry: false });
    this.emit({ type: "agent_settled" });
    this.agentActive = false;
  }

  /** mirror pi's pending-queue snapshot after every enqueue/dequeue */
  private emitQueue() {
    this.emit({
      type: "queue_update",
      steering: this.steering.map((message) => ({ message })),
      followUp: this.followUps.map((message) => ({ message })),
    });
  }

  /**
   * Run one dequeued follow-up as its own turn.
   *
   * Deliberately a compact replay rather than a reuse of the `prompt` case —
   * that branch carries all the error-injection keywords and is left untouched.
   */
  private runQueuedTurn(message: string) {
    this.agentActive = true;
    this.emit({ type: "agent_start" });
    this.emit({ type: "turn_start" });
    this.emit({ type: "message_start" });
    const text = `(mock) ran queued follow-up → "${message}"`;
    let i = 0;
    const tick = () => {
      if (i < text.length) {
        const step = Math.min(3, text.length - i);
        this.emit({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: text.slice(i, i + step) },
        });
        i += step;
        setTimeout(tick, 20);
        return;
      }
      this.emit({ type: "message_end" });
      this.emit({ type: "turn_end" });
      this.emit({ type: "agent_end" });
      this.agentActive = false;
      this.drainFollowUps();
    };
    setTimeout(tick, 120);
  }

  /** start the next queued follow-up, or settle if the queue is empty */
  private drainFollowUps() {
    const next = this.followUps.shift();
    if (next === undefined) {
      this.emit({ type: "agent_settled" });
      return;
    }
    this.emitQueue();
    this.runQueuedTurn(next);
  }

  async send(command: PiCommand): Promise<void> {
    if (!this.started) throw new Error("mock pi is not running");
    const cmd = command as PiCommand & { id?: string };
    if (this.nextCommandFailure?.command === cmd.type) {
      const failure = this.nextCommandFailure;
      this.nextCommandFailure = null;
      if (failure.mode === "send") {
        throw new Error(`mock pi_send failed for ${cmd.type}: broken pipe`);
      }
      if (failure.mode === "timeout") return;
      this.respond(cmd, undefined, `mock ${cmd.type} rejected the request`);
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
        if (msg.includes("err-send")) {
          throw new Error("mock pi_send failed: broken pipe");
        }
        // `err-timeout` deliberately never acks so PiClient.request() hits its
        // own 15s timer — that is the whole point of the case, so it must be
        // checked before respond().
        if (msg.includes("err-timeout")) return;

        this.respond(cmd);

        const armed = /\barm-(compact|model|thinking|session|extension|fork)-(error|timeout|send)\b/.exec(
          msg
        );
        if (armed) {
          const commands: Record<string, string> = {
            compact: "compact",
            model: "set_model",
            thinking: "cycle_thinking_level",
            session: "new_session",
            extension: "extension_ui_response",
            fork: "fork",
          };
          this.nextCommandFailure = {
            command: commands[armed[1]],
            mode: armed[2] as "error" | "timeout" | "send",
          };
          if (armed[1] === "extension") {
            this.emit({
              type: "extension_ui_request",
              id: `ui-fail-${Date.now()}`,
              method: "confirm",
              title: "Mock extension response failure",
              message: "This dialog must stay open when Pi rejects the response.",
            });
          }
          this.emitTextTurn(
            `Armed next ${commands[armed[1]]} command to fail via ${armed[2]}.`
          );
          break;
        }

        if (msg.includes("arm-session-fatal")) {
          this.nextCommandFailure = { command: "new_session", mode: "error" };
          this.failNextStart = true;
          this.emitTextTurn("Armed new_session rejection and restart spawn failure.");
          break;
        }

        if (msg.includes("err-empty")) {
          const assistant = {
            role: "assistant",
            content: [],
            stopReason: "stop",
          };
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          this.emit({ type: "message_start", message: assistant });
          this.emit({ type: "message_end", message: assistant });
          this.emit({ type: "agent_end", messages: [assistant], willRetry: false });
          this.emit({ type: "agent_settled" });
          this.agentActive = false;
          break;
        }

        if (msg.includes("err-summarization")) {
          const text = "Summary retry recovered";
          const assistant = {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          };
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          setTimeout(() => {
            this.emit({
              type: "summarization_retry_scheduled",
              attempt: 1,
              maxAttempts: 3,
              delayMs: 600,
              errorMessage: "529 overloaded_error: summary provider overloaded",
            });
          }, 200);
          setTimeout(() => {
            this.emit({
              type: "summarization_retry_attempt_start",
              source: "compaction",
              reason: "threshold",
            });
          }, 800);
          setTimeout(() => {
            this.emit({ type: "summarization_retry_finished" });
            this.emit({ type: "message_start", message: assistant });
            this.emit({
              type: "message_update",
              message: assistant,
              assistantMessageEvent: { type: "text_end", content: text },
            });
            this.emit({ type: "message_end", message: assistant });
            this.emit({ type: "agent_end", messages: [assistant], willRetry: false });
            this.emit({ type: "agent_settled" });
            this.agentActive = false;
          }, 1600);
          break;
        }

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
          // Real providers hand back a raw body, and pi restarts the attempt
          // counter for every request it retries — so a rate-limited key loops
          // 1/3, 2/3, 1/3, 2/3, … This is the shape that used to stack one
          // banner per attempt.
          const body =
            '429: {"message":"rpm exhausted","type":"quota_exceeded_error","code":"8"}';
          [300, 900, 1500, 2100].forEach((at, i) => {
            setTimeout(() => {
              this.emit({
                type: "auto_retry_start",
                attempt: (i % 2) + 1,
                maxAttempts: 3,
                delayMs: 600,
                errorMessage: body,
              });
            }, at);
          });
          setTimeout(() => {
            this.emit({
              type: "auto_retry_end",
              success: false,
              attempt: 3,
              finalError: body,
            });
            this.emit({ type: "agent_settled" });
            this.agentActive = false;
          }, 2700);
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

        if (msg.includes("err-responses")) {
          const errorMessage =
            'OpenAI API error (403): 403 {"error":{"message":"This account only allows Codex official clients","type":"forbidden_error"}}event: response.failed';
          const assistant = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage,
          };
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          this.emit({ type: "message_start", message: assistant });
          this.emit({ type: "message_end", message: assistant });
          this.emit({ type: "agent_end", messages: [assistant], willRetry: false });
          this.emit({ type: "agent_settled" });
          this.agentActive = false;
          break;
        }

        if (msg.includes("responses-final-only")) {
          const text = "Responses final block received";
          const assistant = {
            role: "assistant",
            content: [{ type: "text", text }],
            stopReason: "stop",
          };
          this.agentActive = true;
          this.emit({ type: "agent_start" });
          this.emit({ type: "message_start", message: assistant });
          this.emit({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "text_end", content: text },
          });
          this.emit({ type: "message_end", message: assistant });
          this.emit({ type: "agent_end", messages: [assistant], willRetry: false });
          this.emit({ type: "agent_settled" });
          this.agentActive = false;
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
              this.agentActive = false;
              // a queued follow-up opens its own run instead of settling here
              this.drainFollowUps();
            }
          };
          tick();
        }, 850);
        break;
      }
      case "steer": {
        const message = (cmd as { message?: string }).message ?? "";
        if (!this.agentActive) {
          // nothing to cut into — real pi has no turn to inject this message in
          this.respond(cmd, undefined, "no active turn to steer");
          break;
        }
        this.respond(cmd);
        this.steering.push(message);
        this.emitQueue();
        // real pi injects at the next tool boundary, not instantly
        setTimeout(() => {
          const injected = this.steering.shift();
          this.emitQueue();
          this.emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: `\n\n(mock) steered mid-turn → "${injected}"\n`,
            },
          });
        }, 700);
        break;
      }
      case "follow_up": {
        const message = (cmd as { message?: string }).message ?? "";
        this.respond(cmd);
        this.followUps.push(message);
        this.emitQueue();
        // idle already? then there is no turn-end to wait for
        if (!this.agentActive) this.drainFollowUps();
        break;
      }
      case "abort":
        this.respond(cmd);
        // pi discards what it has not started yet along with the turn
        this.steering = [];
        this.followUps = [];
        this.emitQueue();
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
      case "new_session": {
        // Emit a fresh session event so lastSessionId updates and the
        // session-event listeners (syncSessionPath, refresh) fire — mirroring
        // what a real pi process does after creating a new session.
        this.respond(cmd);
        this.emit({
          type: "session",
          version: 3,
          id: `mock-session-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd: "/mock/workspace",
        });
        break;
      }
      case "switch_session": {
        // Acknowledge the switch and re-emit the session event with the
        // requested path as id, so the mock restart path stays consistent.
        this.respond(cmd, { sessionPath: (cmd as { sessionPath?: string }).sessionPath });
        this.emit({
          type: "session",
          version: 3,
          id: (cmd as { sessionPath?: string }).sessionPath || "mock-session",
          timestamp: new Date().toISOString(),
          cwd: "/mock/workspace",
        });
        break;
      }
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
      this.agentActive = false;
      this.drainFollowUps();
    }, settleAt + 400);
  }

  onLine(cb: (line: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStderr(_handler: (line: string) => void): () => void {
    return once(() => undefined);
  }

  onExit(_handler: (exit: PiProcessExit) => void): () => void {
    return once(() => undefined);
  }

  async stop(): Promise<void> {
    this.started = false;
    // Keep line listeners registered: PiClient installs them once and reuses
    // the same process port across project/session restarts.
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   PiClient — request/response correlation + typed event subscription
   ──────────────────────────────────────────────────────────────────────────── */

export function createMockPiProcessPort(): PiProcessPort {
  return new MockPiProcessPort();
}

function once(cleanup: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    cleanup();
  };
}

