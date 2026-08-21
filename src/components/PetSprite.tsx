"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { AnimatePresence } from "motion/react";
import type { Pet, PetState } from "@/lib/pet/types";
import { stateToAnimation } from "@/lib/pet/state-lifetimes";
import { currentAnimationFrame } from "@/lib/pet/animator";
import { PetBubble } from "@/components/PetBubble";

/**
 * How much to shrink the sprite inside the pet window.
 *
 * The default Codex frame is 192x208 while the pet window is only 200x250
 * ([src-tauri/src/pet_window.rs](../../src-tauri/src/pet_window.rs)), so
 * rendering 1:1 fills the window edge to edge and leaves no room above the pet
 * for the speech bubble.
 */
export const DEFAULT_PET_SCALE = 0.65;

/**
 * Floor on the scheduled gap between sprite frames.
 *
 * The animator's `delay` comes straight from the authored frame durations, so a
 * hand-written pet manifest with a 0ms frame would otherwise spin setTimeout as
 * fast as the event loop allows. 16ms caps that at roughly one frame of a 60Hz
 * display, which is already far finer than any real sprite timing.
 */
const MIN_FRAME_DELAY_MS = 16;

interface PetSpriteProps {
  pet: Pet;
  state: PetState;
  animationStartedAt: number;
  bubble?: string | null;
  /** Sprite scale factor; 1 renders the spritesheet at native frame size. */
  scale?: number;
  className?: string;
}

/**
 * CSS sprite animation with per-frame timing
 * Ported from Codex's ambient.rs frame scheduling logic
 */
export function PetSprite({
  pet,
  state,
  animationStartedAt,
  bubble,
  scale = DEFAULT_PET_SCALE,
  className = "",
}: PetSpriteProps) {
  const [currentFrame, setCurrentFrame] = useState<number>(0);
  const [broken, setBroken] = useState<boolean>(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Detect when the spritesheet asset itself fails to load (invalid dimensions,
  // corrupt file, or offline CDN fallback) so we can show a visible placeholder
  // instead of a silently transparent — and thus invisible — pet window.
  useEffect(() => {
    const img = new Image();
    let cancelled = false;
    img.onload = () => {
      if (!cancelled) setBroken(false);
    };
    img.onerror = () => {
      if (!cancelled) setBroken(true);
    };
    img.src = pet.spritesheetPath;
    return () => {
      // A decode in flight when the pet is swapped must not report back.
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [pet.spritesheetPath]);

  const animationName = stateToAnimation(state);
  const animation = pet.animations[animationName] || pet.animations.idle;

  // Memoize sprite style to avoid recalc every frame
  const spriteStyle = useMemo(() => {
    const col = currentFrame % pet.columns;
    const row = Math.floor(currentFrame / pet.columns);
    return {
      backgroundImage: `url(${pet.spritesheetPath})`,
      backgroundPosition: `-${col * pet.frameWidth}px -${row * pet.frameHeight}px`,
      backgroundSize: `${pet.frameWidth * pet.columns}px ${pet.frameHeight * pet.rows}px`,
      width: `${pet.frameWidth}px`,
      height: `${pet.frameHeight}px`,
    };
  }, [currentFrame, pet.spritesheetPath, pet.frameWidth, pet.frameHeight, pet.columns, pet.rows]);

  useEffect(() => {
    if (!animation) return;

    let cancelled = false;

    const tick = () => {
      if (cancelled) return;

      // Always derived from wall-clock elapsed time, so a coalesced or delayed
      // timer resumes on the correct frame instead of drifting.
      const elapsed = Date.now() - animationStartedAt;
      const frame = currentAnimationFrame(animation, elapsed);
      setCurrentFrame(frame.spriteIndex);

      if (frame.delay === null) {
        // Static frame — nothing will change until the animation itself does.
        timerRef.current = undefined;
        return;
      }

      // Sleep exactly as long as the animator says this frame lasts. The old
      // code computed `delay` and then threw it away, driving the loop from
      // requestAnimationFrame instead: 300 wakeups/second on a 300Hz display to
      // service an idle animation that changes frame 0.91 times/second.
      timerRef.current = setTimeout(tick, Math.max(frame.delay, MIN_FRAME_DELAY_MS));
    };

    tick();

    return () => {
      cancelled = true;
      if (timerRef.current !== undefined) {
        clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [animation, animationStartedAt]);

  // Scaled layout box. The sprite itself keeps its native pixel size and is
  // shrunk with a transform (so a fractional scale can never sample a
  // neighbouring frame out of the spritesheet), while the wrapper reserves the
  // scaled footprint so the bubble anchors to what is actually on screen.
  const boxWidth = Math.round(pet.frameWidth * scale);
  const boxHeight = Math.round(pet.frameHeight * scale);

  if (broken) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl bg-indigo-500/80 text-white text-xs font-medium px-3 py-2 ${className}`}
        style={{ width: boxWidth, height: boxHeight }}
      >
        {pet.displayName}
        <span className="ml-1 opacity-70">(sprite missing)</span>
      </div>
    );
  }

  return (
    <div
      className={`relative ${className}`}
      style={{ width: boxWidth, height: boxHeight }}
    >
      {/* Sprite */}
      <div
        className="pixelated"
        style={{
          ...spriteStyle,
          imageRendering: "pixelated",
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      />

      {/* Bubble — anchored to the top edge of the sprite with `bottom-full` so
          it grows upward and can never overlap the pet regardless of how tall
          the text renders (a fixed negative offset clipped against the top of
          the 250px pet window). `mode="wait"` lets the old ink lift off the
          paper before the new line is brushed on. */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 flex justify-center" style={{ width: 'max-content' }}>
        <AnimatePresence mode="wait">
          {bubble ? <PetBubble key={bubble} text={bubble} state={state} /> : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
