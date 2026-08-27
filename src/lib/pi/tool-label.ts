"use client";

/**
 * Tool-label formatting — the single source of truth for how one pi tool call
 * reads in the UI. Both the live task strip (via agent-bridge) and the inline
 * activity lines inside a message render from these, so a `Read` looks the same
 * wherever it shows up.
 */

import { useWorkspace } from "@/lib/workspace";

export const EDIT_TOOL =
  /^(edit|write|multi[_-]?edit|str[_-]?replace(?:[_-]?editor)?|create[_-]?file|apply[_-]?patch)$/i;
/**
 * Shell-family tools. pi's `powershell` tool (opt-in on Windows via
 * `defaultTools`) is built from the same definition as `bash` and takes the same
 * `command` argument, so it belongs in this bucket — and must be: agent-bridge
 * only streams tool output to the terminal for `kind === "bash"`.
 */
export const BASH_TOOL = /^(bash|shell|power[_-]?shell|pwsh|run[_-]?command|exec)$/i;
const READ_TOOL = /^(read|view|cat|open[_-]?file|read[_-]?file)$/i;
const SEARCH_TOOL = /^(grep|search|glob|find|rg|ls|list[_-]?(dir|files)?)$/i;
const WEB_TOOL = /^(web[_-]?(search|fetch)|fetch|http|browse|curl)$/i;
const TASK_TOOL = /^(todo(?:[_-]?write)?|task|plan)$/i;
const AGENT_TOOL = /^((sub)?agent|dispatch[_-]?agent|task[_-]?agent)$/i;
const MCP_TOOL = /^mcp(?:$|(?:__|:|\/))/i;

/** Semantic bucket a tool falls into — drives which icon the row shows. */
export type ToolKind =
  | "read"
  | "write"
  | "bash"
  | "search"
  | "web"
  | "task"
  | "agent"
  | "mcp"
  | "other";

export function toolKind(toolName: string): ToolKind {
  if (BASH_TOOL.test(toolName)) return "bash";
  if (EDIT_TOOL.test(toolName)) return "write";
  if (READ_TOOL.test(toolName)) return "read";
  if (SEARCH_TOOL.test(toolName)) return "search";
  if (WEB_TOOL.test(toolName)) return "web";
  if (TASK_TOOL.test(toolName)) return "task";
  if (AGENT_TOOL.test(toolName)) return "agent";
  if (MCP_TOOL.test(toolName)) return "mcp";
  return "other";
}

export function isMcpTool(toolName: string): boolean {
  return MCP_TOOL.test(toolName);
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function argPath(args: Record<string, unknown>): string | undefined {
  const p = args.path ?? args.file_path ?? args.filePath ?? args.file;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

export function argCommand(args: Record<string, unknown>): string | undefined {
  const c = args.command ?? args.cmd ?? args.script;
  return typeof c === "string" && c.length > 0 ? c : undefined;
}

/** normalize to the workspace key style (forward slashes, absolute in Tauri) */
export function normPath(raw: string): string {
  const root = (useWorkspace.getState().root ?? "").replace(/\\/g, "/");
  let p = raw.replace(/\\/g, "/");
  const absolute = /^[a-zA-Z]:\//.test(p) || p.startsWith("/");
  if (!absolute && root) p = root.replace(/\/+$/, "") + "/" + p.replace(/^\.\//, "");
  return p;
}

/** short display path relative to the project root */
export function relPath(p: string): string {
  const root = (useWorkspace.getState().root ?? "").replace(/\\/g, "/");
  const n = p.replace(/\\/g, "/");
  if (root && n.toLowerCase().startsWith(root.toLowerCase())) {
    return n.slice(root.length).replace(/^\/+/, "") || n;
  }
  return n;
}

const POWERSHELL_TOOL = /^(power[_-]?shell|pwsh)$/i;

/**
 * Prompt shown before a shell command — matches the prompt pi's own TUI renders
 * for that tool, so a PowerShell call doesn't read as a POSIX one on Windows.
 */
export function shellPrompt(toolName: string): string {
  return POWERSHELL_TOOL.test(toolName) ? "PS>" : "$";
}

/** headline for a tool call: `$ pnpm build`, `Read src/lib/pi/chat.ts`, `Grep` */
export function toolTitle(toolName: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  if (isMcpTool(toolName)) {
    const action = typeof args.action === "string" ? args.action : undefined;
    const server = typeof args.server === "string" ? args.server : undefined;
    const target = typeof args.tool === "string" ? args.tool : undefined;
    if (toolName.toLowerCase() === "mcp") {
      return ["MCP", action, server && target ? `${server}/${target}` : server || target]
        .filter(Boolean)
        .join(" · ");
    }
    const parts = toolName.split(/__|:|\//).filter(Boolean);
    return ["MCP", parts.slice(1).join("/") || parts[0]].filter(Boolean).join(" · ");
  }
  if (BASH_TOOL.test(toolName)) {
    const cmd = argCommand(args) ?? "";
    return `${shellPrompt(toolName)} ${cmd}`.trim();
  }
  const p = argPath(args);
  const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  return p ? `${name} ${relPath(normPath(p))}` : name;
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(resultText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return [record.text, record.content, record.message, record.result]
      .map(resultText)
      .filter(Boolean)
      .join("\n") || JSON.stringify(value);
  }
  return "";
}

/** Extract a short-lived OAuth authorization URL from an MCP auth-start result. */
export function mcpAuthUrl(toolName: string, value: unknown, rawArgs?: unknown): string | undefined {
  if (!isMcpTool(toolName)) return undefined;
  const args = asRecord(rawArgs);
  const action = typeof args.action === "string" ? args.action.toLowerCase() : undefined;
  if (action && action !== "auth-start") return undefined;

  // pi-mcp-adapter exposes this as a structured detail. Prefer it over text so
  // a normal MCP result containing an OAuth-looking link cannot trigger the UI.
  const result = asRecord(value);
  const details = asRecord(result.details);
  const structuredUrl = details.authorizationUrl;
  if (typeof structuredUrl === "string" && /^https?:\/\//i.test(structuredUrl)) return structuredUrl;

  const text = resultText(value);
  if (!/(?:auth[-_ ]?start|oauth|authorize|authorization)/i.test(text)) return undefined;
  return text.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "");
}

/** Stable adapter syntax shown after a browser OAuth redirect. */
export function mcpAuthCompleteExample(toolName: string, rawArgs: unknown): string | undefined {
  if (!isMcpTool(toolName)) return undefined;
  const server = asRecord(rawArgs).server;
  if (typeof server !== "string" || server.trim().length === 0) return undefined;
  const escaped = server.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `mcp({ action: "auth-complete", server: "${escaped}", args: { code: "PASTE_CODE_HERE" } })`;
}

/** the dimmed trailing half of a row: the args that the title didn't cover */
export function toolDetail(rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const skip = new Set([
    "path",
    "file_path",
    "filePath",
    "file",
    "command",
    "cmd",
    "script",
    "content",
    "oldText",
    "newText",
    "old_str",
    "new_str",
  ]);
  const rest = keys.filter((k) => !skip.has(k));
  return rest
    .slice(0, 3)
    .map((k) => `${k}: ${argPreview(args[k]).slice(0, 40)}`)
    .join(" · ");
}

/**
 * One argument value as a short string. `String()` alone turns any object or
 * array into `[object Object]`, which is what a structured-argument tool used to
 * render as — `plan_mode_question` showed `questions: [object Object]` instead of
 * anything about the questions. Objects go through JSON so the preview carries
 * real content; primitives keep their plain form (no quotes around strings).
 */
function argPreview(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return "…"; // circular or otherwise unserializable
    }
  }
  return String(value);
}
