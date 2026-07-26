/**
 * Test utilities for pet system
 */

import type { Pet, Animation } from "./types";

/**
 * Create a minimal test pet
 */
export function createTestPet(overrides?: Partial<Pet>): Pet {
  return {
    id: "test",
    displayName: "Test Pet",
    description: "A test pet",
    spritesheetPath: "/test-spritesheet.webp",
    frameWidth: 192,
    frameHeight: 208,
    columns: 8,
    rows: 9,
    frameCount: 72,
    animations: {
      idle: {
        frames: [
          { spriteIndex: 0, duration: 1000 },
          { spriteIndex: 1, duration: 1000 },
        ],
        loopStart: 0,
        fallback: "idle",
      },
      running: {
        frames: [
          { spriteIndex: 56, duration: 100 },
          { spriteIndex: 57, duration: 100 },
        ],
        loopStart: 0,
        fallback: "idle",
      },
      waiting: {
        frames: [{ spriteIndex: 48, duration: 500 }],
        loopStart: 0,
        fallback: "idle",
      },
      review: {
        frames: [{ spriteIndex: 64, duration: 500 }],
        loopStart: 0,
        fallback: "idle",
      },
      failed: {
        frames: [{ spriteIndex: 40, duration: 500 }],
        loopStart: 0,
        fallback: "idle",
      },
    },
    ...overrides,
  };
}

/**
 * Create a test animation
 */
export function createTestAnimation(overrides?: Partial<Animation>): Animation {
  return {
    frames: [
      { spriteIndex: 0, duration: 100 },
      { spriteIndex: 1, duration: 100 },
    ],
    loopStart: 0,
    fallback: "idle",
    ...overrides,
  };
}
