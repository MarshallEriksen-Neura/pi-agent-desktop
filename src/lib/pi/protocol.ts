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
  /* bash */
  | { type: "bash"; command: string; id?: string }
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

export interface PiState {
  model?: PiModel;
  thinkingLevel?: ThinkingLevel;
  sessionPath?: string;
  sessionName?: string;
  isStreaming?: boolean;
}

/* ── Events (stdout) ── */

export interface AssistantMessageEvent {
  type: "text_delta" | "thinking_delta" | "toolcall_delta" | string;
  delta?: string;
  [k: string]: unknown;
}

export type PiEvent =
  | { type: "session"; version: number; id: string; timestamp: string; cwd: string }
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: unknown[]; willRetry?: boolean }
  | { type: "agent_settled" }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: unknown; toolResults?: unknown[] }
  | { type: "message_start" }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message?: unknown }
  | { type: "bash_execution_update"; id?: string; delta: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolCallId: string; partialResult?: unknown }
  | { type: "tool_execution_end"; toolCallId: string; result?: unknown; isError?: boolean }
  | { type: "queue_update"; steering?: unknown[]; followUp?: unknown[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; result?: unknown; aborted?: boolean; willRetry?: boolean }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "extension_error"; extensionPath: string; event: string; error: string }
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
