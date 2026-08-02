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
export const BASH_TOOL = /^(bash|shell|run[_-]?command|exec)$/i;
const READ_TOOL = /^(read|view|cat|open[_-]?file|read[_-]?file)$/i;
const SEARCH_TOOL = /^(grep|search|glob|find|rg|ls|list[_-]?(dir|files)?)$/i;
const WEB_TOOL = /^(web[_-]?(search|fetch)|fetch|http|browse|curl)$/i;
const TASK_TOOL = /^(todo(?:[_-]?write)?|task|plan)$/i;
const AGENT_TOOL = /^((sub)?agent|dispatch[_-]?agent|task[_-]?agent)$/i;

/** Semantic bucket a tool falls into — drives which icon the row shows. */
export type ToolKind =
  | "read"
  | "write"
  | "bash"
  | "search"
  | "web"
  | "task"
  | "agent"
  | "other";

export function toolKind(toolName: string): ToolKind {
  if (BASH_TOOL.test(toolName)) return "bash";
  if (EDIT_TOOL.test(toolName)) return "write";
  if (READ_TOOL.test(toolName)) return "read";
  if (SEARCH_TOOL.test(toolName)) return "search";
  if (WEB_TOOL.test(toolName)) return "web";
  if (TASK_TOOL.test(toolName)) return "task";
  if (AGENT_TOOL.test(toolName)) return "agent";
  return "other";
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

/** headline for a tool call: `$ pnpm build`, `Read src/lib/pi/chat.ts`, `Grep` */
export function toolTitle(toolName: string, rawArgs: unknown): string {
  const args = asRecord(rawArgs);
  if (BASH_TOOL.test(toolName)) {
    const cmd = argCommand(args) ?? "";
    return `$ ${cmd}`.trim();
  }
  const p = argPath(args);
  const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  return p ? `${name} ${relPath(normPath(p))}` : name;
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
    .map((k) => `${k}: ${String(args[k]).slice(0, 40)}`)
    .join(" · ");
}
