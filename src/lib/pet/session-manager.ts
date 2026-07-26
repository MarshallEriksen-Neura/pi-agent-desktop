/**
 * Multi-session state manager for pet
 * Handles concurrent sessions and priority-based state resolution
 */

import type { PetState } from "./types";

export interface SessionState {
  sessionId: string;
  state: PetState;
  body?: string;
  priority: number;
  timestamp: number;
  expiresAt: number;
}

/**
 * State priority (higher = more important)
 * failed > waiting > running > review > idle
 */
const STATE_PRIORITY: Record<PetState, number> = {
  failed: 5,
  waiting: 4,
  running: 3,
  review: 2,
  idle: 1,
};

/**
 * State lifetimes in milliseconds
 */
const STATE_LIFETIMES: Record<PetState, number> = {
  idle: Infinity,
  running: 3 * 60 * 1000, // 3 minutes
  waiting: 24 * 60 * 60 * 1000, // 24 hours
  review: 7 * 24 * 60 * 60 * 1000, // 7 days
  failed: 60 * 60 * 1000, // 1 hour
};

class PetSessionManager {
  private sessions = new Map<string, SessionState>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Cleanup expired states every 10 seconds
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 10000);
  }

  /**
   * Update state for a specific session
   */
  updateSession(sessionId: string, state: PetState, body?: string): void {
    const now = Date.now();
    const lifetime = STATE_LIFETIMES[state];

    this.sessions.set(sessionId, {
      sessionId,
      state,
      body,
      priority: STATE_PRIORITY[state],
      timestamp: now,
      expiresAt: lifetime === Infinity ? Infinity : now + lifetime,
    });
  }

  /**
   * Remove a session (e.g. when session closes)
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get the highest-priority active state across all sessions
   */
  getEffectiveState(): { state: PetState; body?: string; sessionId?: string } | null {
    this.cleanupExpired();

    if (this.sessions.size === 0) {
      return { state: "idle" };
    }

    // Find highest priority state
    let best: SessionState | null = null;
    for (const session of this.sessions.values()) {
      if (!best || session.priority > best.priority) {
        best = session;
      } else if (session.priority === best.priority) {
        // Same priority, use most recent
        if (session.timestamp > best.timestamp) {
          best = session;
        }
      }
    }

    return best
      ? { state: best.state, body: best.body, sessionId: best.sessionId }
      : { state: "idle" };
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): SessionState[] {
    this.cleanupExpired();
    return Array.from(this.sessions.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove expired states
   */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.expiresAt !== Infinity && now > session.expiresAt) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Cleanup on destroy
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.sessions.clear();
  }
}

// Singleton instance
export const sessionManager = new PetSessionManager();
