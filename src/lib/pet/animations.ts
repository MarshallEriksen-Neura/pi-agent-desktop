/**
 * Default animation definitions — ported from Codex model.rs
 */

import type { Animation, AnimationFrame } from './types';
import { DEFAULT_COLUMNS } from './types';

const ms = (n: number) => n;

function idleAnimation(): Animation {
  return {
    frames: [
      { spriteIndex: 0, duration: ms(1680) },
      { spriteIndex: 1, duration: ms(660) },
      { spriteIndex: 2, duration: ms(660) },
      { spriteIndex: 3, duration: ms(840) },
      { spriteIndex: 4, duration: ms(840) },
      { spriteIndex: 5, duration: ms(1920) },
    ],
    loopStart: 0,
    fallback: 'idle',
  };
}

/**
 * State animation: repeat primary sequence 3x, then fall into idle loop
 * This creates the "excited → calm" transition without state machine code
 */
function stateAnimation(
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number
): Animation {
  const primaryFrames: AnimationFrame[] = [];
  for (let col = 0; col < frameCount; col++) {
    primaryFrames.push({
      spriteIndex: rowIndex * DEFAULT_COLUMNS + col,
      duration: col === frameCount - 1 ? finalFrameDurationMs : frameDurationMs,
    });
  }

  // 3x repeat + idle tail
  const frames = [
    ...primaryFrames,
    ...primaryFrames,
    ...primaryFrames,
    ...idleAnimation().frames,
  ];

  return {
    frames,
    loopStart: primaryFrames.length * 3, // loop from idle segment
    fallback: 'idle',
  };
}

export function defaultAnimations(): Record<string, Animation> {
  return {
    idle: idleAnimation(),
    'running-right': stateAnimation(1, 8, 120, 220),
    'running-left': stateAnimation(2, 8, 120, 220),
    waving: stateAnimation(3, 4, 140, 280),
    jumping: stateAnimation(4, 5, 140, 280),
    failed: stateAnimation(5, 8, 140, 240),
    waiting: stateAnimation(6, 6, 150, 260),
    running: stateAnimation(7, 6, 120, 220),
    review: stateAnimation(8, 6, 150, 280),
    // aliases
    move_right: stateAnimation(1, 8, 120, 220),
    move_left: stateAnimation(2, 8, 120, 220),
    wave: stateAnimation(3, 4, 140, 280),
    bounce: stateAnimation(4, 5, 140, 280),
    sad: stateAnimation(5, 8, 140, 240),
  };
}
