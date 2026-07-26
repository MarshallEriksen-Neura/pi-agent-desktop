"use client";

/**
 * Pet state store — tracks active pet, current state, and manages lifecycle
 */

import { create } from "zustand";
import type { Pet, PetState } from "./types";
import { isStateExpired, STATE_FALLBACK_BODIES } from "./state-lifetimes";

interface PetStore {
  /** Currently loaded pet (null = disabled) */
  activePet: Pet | null;
  /** Current semantic state */
  state: PetState;
  /** Optional body text (e.g. task preview) */
  body: string | null;
  /** When the current state was set (for expiry) */
  stateTimestamp: number;
  /** Animation start time (for frame calculation) */
  animationStartedAt: number;
  /** Pet window visible */
  windowVisible: boolean;

  /** Load a pet (from builtin or custom) */
  loadPet: (pet: Pet) => void;
  /** Disable pet */
  disablePet: () => void;
  /** Update state (from agent events) */
  setState: (state: PetState, body?: string) => void;
  /** Check expiry and return to idle if needed */
  checkExpiry: () => void;
  /** Show/hide pet window */
  setWindowVisible: (visible: boolean) => void;
}

export const usePet = create<PetStore>((set, get) => ({
  activePet: null,
  state: "idle",
  body: null,
  stateTimestamp: Date.now(),
  animationStartedAt: Date.now(),
  windowVisible: false,

  loadPet: (pet) =>
    set({
      activePet: pet,
      state: "idle",
      body: null,
      stateTimestamp: Date.now(),
      animationStartedAt: Date.now(),
    }),

  disablePet: () =>
    set({
      activePet: null,
      state: "idle",
      body: null,
      windowVisible: false,
    }),

  setState: (state, body) =>
    set({
      state,
      body: body ?? (STATE_FALLBACK_BODIES[state] || null),
      stateTimestamp: Date.now(),
      animationStartedAt: Date.now(),
    }),

  checkExpiry: () => {
    const { state, stateTimestamp } = get();
    if (state !== "idle" && isStateExpired(state, stateTimestamp)) {
      set({
        state: "idle",
        body: null,
        stateTimestamp: Date.now(),
        animationStartedAt: Date.now(),
      });
    }
  },

  setWindowVisible: (visible) => set({ windowVisible: visible }),
}));
