import type { ChatMessage, ChatToolCall } from "./chat";
import { mcpAuthUrl } from "./tool-label";

/**
 * Structural subset of Pi 0.84's exported SessionEntry types used at the RPC
 * boundary. Keeping this decoder structural lets the desktop tolerate new
 * metadata entry kinds without maintaining a second JSONL schema.
 */
export interface PiSessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: unknown;
  [key: string]: unknown;
}

export interface PiEntriesSnapshot {
  entries: PiSessionEntry[];
  leafId: string | null;
}

export class SessionTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}


/** Resolve exactly the active Pi branch selected by get_entries.leafId. */
export function activeSessionBranch(snapshot: PiEntriesSnapshot): PiSessionEntry[] {
  const entries = snapshot.entries.filter((entry) => entry.type !== "session");
  if (snapshot.leafId === null) return [];

  const byId = new Map<string, PiSessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (byId.has(entry.id)) {
      throw new SessionTranscriptError(`Pi session contains duplicate entry id ${entry.id}`);
    }
    byId.set(entry.id, entry);
  }

  const path: PiSessionEntry[] = [];
  const visited = new Set<string>();
  let cursor: string | null = snapshot.leafId;
  while (cursor !== null) {
    if (visited.has(cursor)) {
      throw new SessionTranscriptError(`Pi session branch contains a cycle at ${cursor}`);
    }
    visited.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) {
      throw new SessionTranscriptError(`Pi session branch references missing entry ${cursor}`);
    }
    path.push(entry);
    cursor = typeof entry.parentId === "string" ? entry.parentId : null;
  }
  path.reverse();
  return path;
}

function contentBlocks(message: UnknownRecord): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return [];
}

function textAndImages(message: UnknownRecord): { text: string; images?: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  for (const rawBlock of contentBlocks(message)) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      images.push(`data:${block.mimeType};base64,${block.data}`);
    }
  }
  return { text: texts.join("\n"), ...(images.length > 0 ? { images } : {}) };
}

function assistantParts(message: UnknownRecord): {
  text: string;
  thinking?: string;
  tools?: ChatToolCall[];
} {
  const texts: string[] = [];
  const thoughts: string[] = [];
  const tools: ChatToolCall[] = [];
  for (const rawBlock of contentBlocks(message)) {
    const block = record(rawBlock);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      thoughts.push(block.thinking);
    } else if (
      block.type === "toolCall" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      tools.push({
        id: block.id,
        name: block.name,
        args: record(block.arguments) ?? undefined,
        status: "running",
      });
    }
  }
  return {
    text: texts.join("\n"),
    ...(thoughts.length > 0 ? { thinking: thoughts.join("\n") } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Convert Pi's native active branch to the desktop display/cache model.
 * Compaction, branch_summary, labels and model/settings entries are branch
 * metadata; original message entries remain on the branch and are what the UI
 * renders. Tool-result messages resolve tool calls on their assistant bubble.
 */
export function sessionEntriesToChatMessages(snapshot: PiEntriesSnapshot): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, { call: ChatToolCall; args?: unknown }>();

  for (const entry of activeSessionBranch(snapshot)) {
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (!message) {
      throw new SessionTranscriptError(`Pi message entry ${entry.id} has no valid message payload`);
    }
    const role = str(message.role);

    if (role === "user") {
      const content = textAndImages(message);
      messages.push({
        id: entry.id as string,
        role: "user",
        text: content.text,
        images: content.images,
        thinking: "",
        tools: [],
        streaming: false,
      });
      continue;
    }

    if (role === "assistant") {
      const parts = assistantParts(message);
      const stopReason = str(message.stopReason);
      const errorMessage = str(message.errorMessage);
      const chatMessage: ChatMessage = {
        id: entry.id as string,
        role: "assistant",
        text: parts.text,
        thinking: parts.thinking ?? "",
        tools: parts.tools ?? [],
        streaming: false,
        isError: stopReason === "error" || Boolean(errorMessage),
        errorText: errorMessage,
      };
      messages.push(chatMessage);
      for (const call of parts.tools ?? []) {
        tools.set(call.id, { call, args: call.args });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = str(message.toolCallId);
      if (!toolCallId) {
        throw new SessionTranscriptError(`Pi tool result entry ${entry.id} has no toolCallId`);
      }
      const pending = tools.get(toolCallId);
      if (!pending) {
        throw new SessionTranscriptError(
          `Pi tool result entry ${entry.id} references missing tool call ${toolCallId}`
        );
      }
      pending.call.status = message.isError === true ? "error" : "done";
      pending.call.authUrl = mcpAuthUrl(pending.call.name, message, pending.args);
      continue;
    }

    throw new SessionTranscriptError(`Pi message entry ${entry.id} has unsupported role ${String(role)}`);
  }

  return messages;
}
