/**
 * pi coding agent — RPC protocol types (stdin/stdout JSONL).
 * Source: pi-mono packages/coding-agent/docs/rpc.md
 * Strict JSONL: LF-delimited, one JSON object per line.
 */

/* ── Commands (stdin) ── */

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Attachment payload for prompt/steer/follow_up — raw base64, no data-URL prefix. */
export interface PiImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type PiCommand =
  /* prompting */
  | { type: "prompt"; message: string; images?: PiImage[]; id?: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string; images?: PiImage[] }
  | { type: "follow_up"; message: string; images?: PiImage[] }
  | { type: "abort" }
  | { type: "new_session"; parentSession?: string }
  /* state */
  | { type: "get_state" }
  | { type: "get_messages" }
  | { type: "get_last_assistant_text" }
  /* model management */
  | { type: "set_model"; provider: string; modelId: string }
  | { type: "cycle_model" }
  | { type: "get_available_models" }
  /* thinking */
  | { type: "set_thinking_level"; level: ThinkingLevel }
  | { type: "cycle_thinking_level" }
  | { type: "get_available_thinking_levels" }
  /* queue modes */
  | { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
  | { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
  /* compaction / retry */
  | { type: "compact"; customInstructions?: string }
  | { type: "set_auto_compaction"; enabled: boolean }
  | { type: "set_auto_retry"; enabled: boolean }
  | { type: "abort_retry" }
  /* bash — `id` correlates the streamed bash_execution_update events */
  | { type: "bash"; command: string; id?: string; excludeFromContext?: boolean }
  | { type: "abort_bash" }
  /* sessions */
  | { type: "get_session_stats" }
  | { type: "export_html"; outputPath: string }
  | { type: "switch_session"; sessionPath: string }
  | { type: "set_session_name"; name: string }
  | { type: "fork"; entryId: string }
  | { type: "clone" }
  | { type: "get_fork_messages" }
  | { type: "get_entries"; since?: string }
  | { type: "get_tree" }
  /* commands & extension UI */
  | { type: "get_commands" }
  | ExtensionUiResponse;

export type PiCommandType = PiCommand["type"];

/* the harness answers extension UI requests over stdin */
export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/* ── Responses ── */

export interface PiResponse<T = unknown> {
  type: "response";
  command: PiCommandType | string;
  success: boolean;
  id?: string;
  data?: T;
  error?: string;
}

/* ── Data shapes we rely on ── */

export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: number; // $/Mtok
  output?: number;
}

/**
 * `data` of a successful `bash` response — the *final* result. While the command
 * runs, output also streams as `bash_execution_update` events (see PiEvent), so
 * a long command need not look frozen until it exits. `output` here may be
 * truncated even though the event stream carried everything.
 */
export interface BashResult {
  /** combined stdout + stderr (sanitized, possibly truncated) */
  output: string;
  /** undefined if killed/cancelled */
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  /** present when truncated — full log on disk */
  fullOutputPath?: string;
}

export interface PiState {
  model?: PiModel;
  thinkingLevel?: ThinkingLevel;
  /** @deprecated pi returns `sessionFile` + `sessionId` instead. Kept for back-compat. */
  sessionPath?: string;
  /** Full path to the .jsonl session file (what pi's get_state actually returns). */
  sessionFile?: string;
  /** Session UUID (what pi's get_state actually returns; --session accepts it). */
  sessionId?: string;
  sessionName?: string;
  isStreaming?: boolean;
}

/* ── Events (stdout) ── */

/**
 * One streaming delta inside `message_update`. Only the `*_delta` variants carry
 * `delta`; `text_end` / `thinking_end` may carry the complete final block in
 * `content` even when a provider emitted no deltas. `error` carries no `delta`
 * at all — both shapes must be handled before any delta guard.
 */
export interface AssistantMessageEvent {
  type:
    | "start"
    | "text_start"
    | "text_delta"
    | "text_end"
    | "thinking_start"
    | "thinking_delta"
    | "thinking_end"
    | "toolcall_start"
    | "toolcall_delta"
    | "toolcall_end"
    | "done"
    | "error"
    | string;
  delta?: string;
  /** full block on text_end / thinking_end (some Responses providers only emit this) */
  content?: string;
  /** index of the content block this delta belongs to */
  contentIndex?: number;
  /** type "done" — why generation stopped */
  reason?: "aborted" | "error" | "stop" | "length" | "toolUse" | string;
  [k: string]: unknown;
}

export type PiEvent =
  | { type: "session"; version: number; id: string; timestamp: string; cwd: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown[] }
  | { type: "message_start"; message?: unknown }
  | { type: "message_update"; message?: unknown; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message?: unknown }
  /**
   * Output of a direct `bash` command, one event per chunk. Unlike
   * `tool_execution_update.partialResult` (which is cumulative), `delta` here is
   * an increment — append it. `id` echoes the `id` of the originating `bash`
   * command, so concurrent commands can be told apart.
   */
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName?: string;
      args?: unknown;
      /** accumulated output so far — NOT a delta; replace, don't append */
      partialResult?: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "queue_update"; steering?: unknown[]; followUp?: unknown[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      result?: unknown;
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      /** the transient error that triggered the retry (429 / 5xx / overloaded) */
      errorMessage?: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
  | {
      type: "summarization_retry_scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | { type: "summarization_retry_attempt_start"; source?: string; reason?: string }
  | { type: "summarization_retry_finished" }
  | ExtensionUiRequest
  | PiResponse;

export type PiEventType = PiEvent["type"];

/* extensions ask the host UI for interaction — maps 1:1 onto our sheets */
export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method:
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "notify"
    | "setStatus"
    | "setWidget"
    | "setTitle"
    | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
  timeout?: number;
}

export function parsePiLine(line: string): PiEvent | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    return typeof obj === "object" && obj && "type" in obj
      ? (obj as PiEvent)
      : null;
  } catch {
    return null; // non-JSON noise (e.g. npm warnings) — ignore
  }
}
