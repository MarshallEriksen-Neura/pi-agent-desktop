/**
 * Pet state lifetime management — ported from Codex ambient.rs
 */

import type { PetState } from './types';

// How long each state persists before auto-returning to idle
export const STATE_LIFETIMES: Record<PetState, number> = {
  idle: Infinity,
  running: 3 * 60 * 1000, // 3 minutes
  waiting: 24 * 60 * 60 * 1000, // 24 hours
  review: 7 * 24 * 60 * 60 * 1000, // 7 days
  failed: 60 * 60 * 1000, // 1 hour
};

export const STATE_LABELS: Record<PetState, string> = {
  idle: 'Idle',
  running: 'Running',
  waiting: 'Needs input',
  review: 'Ready',
  failed: 'Blocked',
};

export const STATE_FALLBACK_BODIES: Record<PetState, string> = {
  idle: '',
  running: 'Thinking',
  waiting: 'Needs input',
  review: 'Ready',
  failed: 'Blocked',
};

/**
 * Map state to animation name
 */
export function stateToAnimation(state: PetState): string {
  return state; // direct mapping for now
}

/**
 * Check if a state has expired
 */
export function isStateExpired(state: PetState, timestamp: number): boolean {
  if (state === 'idle') return false;
  const elapsed = Date.now() - timestamp;
  return elapsed >= STATE_LIFETIMES[state];
}
