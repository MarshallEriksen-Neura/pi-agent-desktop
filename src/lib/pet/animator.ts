/**
 * Pet animation engine — frame-accurate playback with loop/fallback chains
 */

import type { Animation } from './types';

export interface AnimationTick {
  spriteIndex: number;
  delay: number | null; // ms until next frame, null if static
}

/** Frame-count-invariant sums for one animation. */
interface AnimationTimings {
  /** Sum of every frame duration. */
  totalDuration: number;
  /** Sum of the frames before `loopStart` (0 when the animation does not loop). */
  prefixDuration: number;
  /** Sum of the frames from `loopStart` onward (0 when the animation does not loop). */
  loopDuration: number;
}

/**
 * These three sums depend only on the animation's frame list, which never
 * changes once a pet is loaded — but they used to be recomputed on every tick
 * via three `reduce` passes and two `slice` allocations. The pet window ticks
 * for as long as it is open, so that was ~600 throwaway arrays per second on a
 * 300Hz display. Keyed weakly so the entry dies with the pet that owns it.
 */
const timingCache = new WeakMap<Animation, AnimationTimings>();

function timingsFor(animation: Animation): AnimationTimings {
  const cached = timingCache.get(animation);
  if (cached) return cached;

  const { frames, loopStart } = animation;
  const loops = loopStart !== null && loopStart < frames.length;

  let totalDuration = 0;
  let prefixDuration = 0;
  let loopDuration = 0;

  for (let i = 0; i < frames.length; i++) {
    // Raw `duration` on purpose: frameAtElapsed clamps to >=1 per frame but
    // these sums never did, and that asymmetry is load-bearing for any
    // animation carrying a zero-duration frame.
    const duration = frames[i].duration;
    totalDuration += duration;
    if (!loops) continue;
    if (i < loopStart!) prefixDuration += duration;
    else loopDuration += duration;
  }

  const timings: AnimationTimings = { totalDuration, prefixDuration, loopDuration };
  timingCache.set(animation, timings);
  return timings;
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

  const { totalDuration, prefixDuration, loopDuration } = timingsFor(animation);

  // Handle looping
  if (animation.loopStart !== null && animation.loopStart < animation.frames.length) {
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
  if (animation.frames.length === 0) return 0;
  return timingsFor(animation).totalDuration;
}
