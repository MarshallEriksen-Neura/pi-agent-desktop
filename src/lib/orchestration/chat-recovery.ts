export interface ChatRecoveryTarget {
  cwd?: string;
  resumePath?: string;
}

export interface ChatRecoveryService {
  getTarget(): ChatRecoveryTarget;
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

export function getChatRecoveryTarget(): ChatRecoveryTarget | null {
  return service?.getTarget() ?? null;
}

export function resetChatRecoveryForTests(): void {
  service = null;
}
