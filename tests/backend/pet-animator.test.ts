import assert from "node:assert/strict";
import test from "node:test";
import {
  animationDuration,
  currentAnimationFrame,
  type AnimationTick,
} from "../../src/lib/pet/animator";
import { defaultAnimations } from "../../src/lib/pet/animations";
import type { Animation } from "../../src/lib/pet/types";

/**
 * Verbatim copy of the pre-optimization implementation, kept as the oracle.
 *
 * The optimized version hoists three reduce passes and two slice allocations
 * into a WeakMap cache. That is only a safe trade if it is bit-for-bit
 * equivalent, including the quirk that the duration *sums* use raw
 * `frame.duration` while `frameAtElapsed` clamps each frame to >= 1ms.
 */
function referenceFrame(animation: Animation, elapsedMs: number): AnimationTick {
  if (animation.frames.length === 0) {
    return { spriteIndex: 0, delay: null };
  }
  if (animation.frames.length === 1) {
    return { spriteIndex: animation.frames[0].spriteIndex, delay: null };
  }
  const totalDuration = animation.frames.reduce((sum, f) => sum + f.duration, 0);

  if (animation.loopStart !== null && animation.loopStart < animation.frames.length) {
    const prefixDuration = animation.frames
      .slice(0, animation.loopStart)
      .reduce((sum, f) => sum + f.duration, 0);
    const loopDuration = animation.frames
      .slice(animation.loopStart)
      .reduce((sum, f) => sum + f.duration, 0);

    let effectiveElapsed = elapsedMs;
    if (elapsedMs >= totalDuration && loopDuration > 0) {
      effectiveElapsed = prefixDuration + ((elapsedMs - prefixDuration) % loopDuration);
    }
    return referenceFrameAtElapsed(animation, effectiveElapsed);
  }

  if (elapsedMs >= totalDuration) {
    const lastFrame = animation.frames[animation.frames.length - 1];
    return { spriteIndex: lastFrame.spriteIndex, delay: null };
  }
  return referenceFrameAtElapsed(animation, elapsedMs);
}

function referenceFrameAtElapsed(animation: Animation, elapsedMs: number): AnimationTick {
  let remaining = elapsedMs;
  for (const frame of animation.frames) {
    const dur = Math.max(frame.duration, 1);
    if (remaining < dur) {
      return { spriteIndex: frame.spriteIndex, delay: dur - remaining };
    }
    remaining -= dur;
  }
  const lastFrame = animation.frames[animation.frames.length - 1];
  return { spriteIndex: lastFrame.spriteIndex, delay: null };
}

const rawTotal = (a: Animation) => a.frames.reduce((s, f) => s + f.duration, 0);

test("every default animation is frame-for-frame identical, ms by ms", () => {
  const animations = Object.entries(defaultAnimations());
  assert.ok(animations.length >= 14, "expected the full default animation set");

  for (const [name, animation] of animations) {
    // Three full cycles plus a tail, at 1ms resolution: covers the initial
    // sequence, the loop wrap, and well past exhaust.
    const limit = rawTotal(animation) * 3 + 1000;
    for (let elapsed = 0; elapsed <= limit; elapsed++) {
      const got = currentAnimationFrame(animation, elapsed);
      const want = referenceFrame(animation, elapsed);
      if (got.spriteIndex !== want.spriteIndex || got.delay !== want.delay) {
        assert.deepEqual(got, want, `${name} diverged at elapsed=${elapsed}ms`);
      }
    }
  }
});

test("animationDuration still matches a plain reduce", () => {
  for (const [name, animation] of Object.entries(defaultAnimations())) {
    assert.equal(animationDuration(animation), rawTotal(animation), name);
  }
  assert.equal(
    animationDuration({ frames: [], loopStart: 0, fallback: "idle" }),
    0,
    "empty animation has no duration"
  );
});

test("edge shapes match the oracle", () => {
  const cases: Array<[string, Animation]> = [
    ["empty", { frames: [], loopStart: 0, fallback: "idle" }],
    ["single", { frames: [{ spriteIndex: 3, duration: 500 }], loopStart: 0, fallback: "idle" }],
    [
      "zero-duration frames (sums vs the >=1ms clamp disagree on purpose)",
      {
        frames: [
          { spriteIndex: 0, duration: 0 },
          { spriteIndex: 1, duration: 0 },
          { spriteIndex: 2, duration: 100 },
        ],
        loopStart: 0,
        fallback: "idle",
      },
    ],
    [
      "non-looping sticks on the last frame",
      {
        frames: [
          { spriteIndex: 0, duration: 100 },
          { spriteIndex: 1, duration: 100 },
        ],
        loopStart: null,
        fallback: "idle",
      },
    ],
    [
      "loopStart beyond the frame list falls through to the non-looping path",
      {
        frames: [
          { spriteIndex: 0, duration: 100 },
          { spriteIndex: 1, duration: 100 },
        ],
        loopStart: 99,
        fallback: "idle",
      },
    ],
    [
      "mid-list loopStart keeps its prefix",
      {
        frames: [
          { spriteIndex: 0, duration: 300 },
          { spriteIndex: 1, duration: 100 },
          { spriteIndex: 2, duration: 100 },
        ],
        loopStart: 1,
        fallback: "idle",
      },
    ],
  ];

  for (const [label, animation] of cases) {
    for (let elapsed = -50; elapsed <= 1500; elapsed++) {
      assert.deepEqual(
        currentAnimationFrame(animation, elapsed),
        referenceFrame(animation, elapsed),
        `${label} diverged at elapsed=${elapsed}ms`
      );
    }
  }
});

test("cached timings are per-object, not per-shape", () => {
  // The WeakMap must not let one pet's animation answer for another's.
  const a: Animation = {
    frames: [
      { spriteIndex: 0, duration: 100 },
      { spriteIndex: 1, duration: 100 },
    ],
    loopStart: 0,
    fallback: "idle",
  };
  const b: Animation = {
    frames: [
      { spriteIndex: 8, duration: 900 },
      { spriteIndex: 9, duration: 900 },
    ],
    loopStart: 0,
    fallback: "idle",
  };

  assert.deepEqual(currentAnimationFrame(a, 150), { spriteIndex: 1, delay: 50 });
  assert.deepEqual(currentAnimationFrame(b, 150), { spriteIndex: 8, delay: 750 });
  // second pass hits the cache for both
  assert.deepEqual(currentAnimationFrame(a, 150), { spriteIndex: 1, delay: 50 });
  assert.deepEqual(currentAnimationFrame(b, 150), { spriteIndex: 8, delay: 750 });
  assert.equal(animationDuration(a), 200);
  assert.equal(animationDuration(b), 1800);
});

test("a non-null delay is always positive, so scheduling on it cannot spin", () => {
  // This is the precondition for driving the loop with setTimeout(delay)
  // instead of requestAnimationFrame.
  for (const [name, animation] of Object.entries(defaultAnimations())) {
    const limit = rawTotal(animation) * 2;
    for (let elapsed = 0; elapsed <= limit; elapsed += 7) {
      const { delay } = currentAnimationFrame(animation, elapsed);
      if (delay !== null) {
        assert.ok(delay > 0, `${name} produced delay=${delay} at elapsed=${elapsed}ms`);
      }
    }
  }
});

test("delay-driven scheduling wakes ~1x/sec where 300Hz rAF woke 300x", () => {
  const MIN_FRAME_DELAY_MS = 16; // mirrors PetSprite
  const WINDOW_MS = 60_000;

  const idle = defaultAnimations().idle;
  let elapsed = 0;
  let wakeups = 0;
  while (elapsed < WINDOW_MS) {
    const { delay } = currentAnimationFrame(idle, elapsed);
    wakeups++;
    if (delay === null) break; // static: the loop parks itself
    elapsed += Math.max(delay, MIN_FRAME_DELAY_MS);
  }

  // idle is 6 frames over 6600ms -> ~55 sprite changes per minute.
  assert.ok(
    wakeups > 40 && wakeups < 80,
    `expected ~55 wakeups per minute, got ${wakeups}`
  );
  // The old rAF loop ran at the display refresh rate regardless.
  const rafWakeups = 300 * (WINDOW_MS / 1000);
  assert.ok(
    rafWakeups / wakeups > 200,
    `expected a >200x reduction, got ${(rafWakeups / wakeups).toFixed(0)}x`
  );
});

test("a static frame reports delay=null so the loop can stop entirely", () => {
  const single: Animation = {
    frames: [{ spriteIndex: 4, duration: 100 }],
    loopStart: 0,
    fallback: "idle",
  };
  assert.equal(currentAnimationFrame(single, 0).delay, null);

  const finite: Animation = {
    frames: [
      { spriteIndex: 0, duration: 100 },
      { spriteIndex: 1, duration: 100 },
    ],
    loopStart: null,
    fallback: "idle",
  };
  assert.equal(currentAnimationFrame(finite, 5_000).delay, null);
});
