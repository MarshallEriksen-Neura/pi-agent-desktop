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
 * State animation: repeat primary sequence 3x, then fall into idle frames.
 * This creates the "excited → calm" transition without state machine code.
 *
 * `cycle` decides what happens after that first burst:
 *
 * - `"decay"` (default, Codex behaviour) loops the idle tail forever, so the
 *   pet goes quiet and stays quiet. Right for terminal states — a task that
 *   finished should not keep dancing for the 7 days `review` lives.
 * - `"recur"` loops the whole burst + calm sequence, so an in-progress state
 *   re-announces itself every ~9s instead of animating nonstop. Used for the
 *   states that exist to pull the user back (`running`, `waiting`).
 *
 * Note that the animation clock only restarts when `setState` runs, i.e. when
 * the state or the bubble text actually changes — so `"decay"` on a long turn
 * with no tool events means one burst and then nothing until the next event.
 */
function stateAnimation(
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
  cycle: "decay" | "recur" = "decay"
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
    // decay → loop the idle segment; recur → loop burst and calm together
    loopStart: cycle === "recur" ? 0 : primaryFrames.length * 3,
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
    // in-progress states keep cycling so a minimized user still gets nudged
    waiting: stateAnimation(6, 6, 150, 260, "recur"),
    running: stateAnimation(7, 6, 120, 220, "recur"),
    review: stateAnimation(8, 6, 150, 280),
    // aliases
    move_right: stateAnimation(1, 8, 120, 220),
    move_left: stateAnimation(2, 8, 120, 220),
    wave: stateAnimation(3, 4, 140, 280),
    bounce: stateAnimation(4, 5, 140, 280),
    sad: stateAnimation(5, 8, 140, 240),
  };
}
