import { invoke } from "@tauri-apps/api/core";

export type DesktopInvokeErrorKind =
  | "command-failed"
  | "permission-denied"
  | "command-not-found"
  | "invalid-args"
  | "unknown";

export interface DesktopInvokeErrorDetail {
  command: string;
  kind: DesktopInvokeErrorKind;
  message: string;
  cause: unknown;
}

export class DesktopInvokeError extends Error {
  public readonly command: string;
  public readonly kind: DesktopInvokeErrorKind;
  public readonly cause: unknown;

  constructor(detail: DesktopInvokeErrorDetail) {
    super(detail.message);
    this.name = "DesktopInvokeError";
    this.command = detail.command;
    this.kind = detail.kind;
    this.cause = detail.cause;
  }
}

export async function desktopInvoke<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeDesktopInvokeError(command, error);
  }
}

export function normalizeDesktopInvokeError(command: string, error: unknown): DesktopInvokeError {
  const message = invokeErrorMessage(error);
  return new DesktopInvokeError({
    command,
    kind: classifyInvokeError(message),
    message,
    cause: error,
  });
}

function invokeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function classifyInvokeError(message: string): DesktopInvokeErrorKind {
  const text = message.toLowerCase();
  if (text.includes("permission denied") || text.includes("not allowed")) {
    return "permission-denied";
  }
  if (text.includes("command not found") || text.includes("unknown command")) {
    return "command-not-found";
  }
  if (text.includes("invalid args") || text.includes("invalid argument")) {
    return "invalid-args";
  }
  if (message) return "command-failed";
  return "unknown";
}
