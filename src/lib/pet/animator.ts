/**
 * Pet animation engine — frame-accurate playback with loop/fallback chains
 */

import type { Animation } from './types';

export interface AnimationTick {
  spriteIndex: number;
  delay: number | null; // ms until next frame, null if static
}

/**
 * Current frame + next-frame delay for a given animation at elapsed time
 * Implements the Codex animation model: loop from loopStart, fallback on exhaust
 */
export function currentAnimationFrame(
  animation: Animation,
  elapsedMs: number
): AnimationTick {
  if (animation.frames.length === 0) {
    return { spriteIndex: 0, delay: null };
  }

  if (animation.frames.length === 1) {
    return { spriteIndex: animation.frames[0].spriteIndex, delay: null };
  }

  const totalDuration = animation.frames.reduce((sum, f) => sum + f.duration, 0);

  // Handle looping
  if (animation.loopStart !== null && animation.loopStart < animation.frames.length) {
    const prefixDuration = animation.frames
      .slice(0, animation.loopStart)
      .reduce((sum, f) => sum + f.duration, 0);
    const loopDuration = animation.frames
      .slice(animation.loopStart)
      .reduce((sum, f) => sum + f.duration, 0);

    let effectiveElapsed = elapsedMs;
    if (elapsedMs >= totalDuration && loopDuration > 0) {
      // We're past the initial sequence, loop from loopStart
      effectiveElapsed = prefixDuration + ((elapsedMs - prefixDuration) % loopDuration);
    }

    return frameAtElapsed(animation, effectiveElapsed);
  }

  // Non-looping: stick on last frame after exhaust
  if (elapsedMs >= totalDuration) {
    const lastFrame = animation.frames[animation.frames.length - 1];
    return { spriteIndex: lastFrame.spriteIndex, delay: null };
  }

  return frameAtElapsed(animation, elapsedMs);
}

function frameAtElapsed(animation: Animation, elapsedMs: number): AnimationTick {
  let remaining = elapsedMs;
  for (const frame of animation.frames) {
    const dur = Math.max(frame.duration, 1);
    if (remaining < dur) {
      return {
        spriteIndex: frame.spriteIndex,
        delay: dur - remaining,
      };
    }
    remaining -= dur;
  }

  // Shouldn't reach here, but fallback to last frame
  const lastFrame = animation.frames[animation.frames.length - 1];
  return { spriteIndex: lastFrame.spriteIndex, delay: null };
}

/**
 * Total duration of an animation (before looping)
 */
export function animationDuration(animation: Animation): number {
  return animation.frames.reduce((sum, f) => sum + f.duration, 0);
}
