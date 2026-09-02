import type { ChatMessage } from "../pi/chat";

export class SessionCacheDecodeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "SessionCacheDecodeError";
  }
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function validImage(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("data:");
}

function validTool(value: unknown): boolean {
  const tool = record(value);
  return Boolean(
    tool &&
      typeof tool.id === "string" &&
      typeof tool.name === "string" &&
      (tool.status === "running" || tool.status === "done" || tool.status === "error")
  );
}

function validMessage(value: unknown): value is ChatMessage {
  const message = record(value);
  if (
    !message ||
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant") ||
    typeof message.text !== "string" ||
    typeof message.thinking !== "string" ||
    !Array.isArray(message.tools) ||
    !message.tools.every(validTool) ||
    typeof message.streaming !== "boolean"
  ) {
    return false;
  }
  if (message.images !== undefined && (!Array.isArray(message.images) || !message.images.every(validImage))) {
    return false;
  }
  return true;
}

/** Decode the legacy array cache without conflating corruption with an empty chat. */
export function decodeSessionMessages(json: string): ChatMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new SessionCacheDecodeError(
      `Cached transcript is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(value)) {
    throw new SessionCacheDecodeError("Cached transcript must be an array");
  }
  const invalidIndex = value.findIndex((message) => !validMessage(message));
  if (invalidIndex >= 0) {
    throw new SessionCacheDecodeError(`Cached transcript contains an invalid message at index ${invalidIndex}`);
  }
  return value;
}
