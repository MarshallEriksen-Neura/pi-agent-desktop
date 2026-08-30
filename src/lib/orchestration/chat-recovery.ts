import type { ExecutionBinding } from "../backend/ports/execution-target";

export interface ChatRecoveryTarget {
  cwd?: string;
  resumePath?: string;
  executionBinding?: ExecutionBinding;
}

export interface ChatRecoveryService {
  /**
   * Recovery target for `taskId`, or the focused conversation when omitted.
   *
   * Per-task resolution matters because every conversation owns its own pi
   * process and its own session file: recovering a background task against the
   * *active* conversation's path would point two processes at one file.
   */
  getTarget(taskId?: string): ChatRecoveryTarget;
}

let service: ChatRecoveryService | null = null;

/**
 * Installs the desktop chat-recovery dependency before chat event handlers start.
 * Configuration is explicit and single-assignment in production so a late
 * remount cannot redirect recovery to another project/session accidentally.
 */
export function configureChatRecovery(serviceImpl: ChatRecoveryService): void {
  if (service && service !== serviceImpl) {
    throw new Error("Chat recovery service is already configured.");
  }
  service = serviceImpl;
}

export function getChatRecoveryTarget(taskId?: string): ChatRecoveryTarget | null {
  return service?.getTarget(taskId) ?? null;
}

export function resetChatRecoveryForTests(): void {
  service = null;
}
