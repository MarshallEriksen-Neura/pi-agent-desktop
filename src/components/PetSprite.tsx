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
  const rafRef = useRef<number | undefined>(undefined);

  // Detect when the spritesheet asset itself fails to load (invalid dimensions,
  // corrupt file, or offline CDN fallback) so we can show a visible placeholder
  // instead of a silently transparent — and thus invisible — pet window.
  useEffect(() => {
    const img = new Image();
    img.onload = () => setBroken(false);
    img.onerror = () => setBroken(true);
    img.src = pet.spritesheetPath;
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

    const tick = () => {
      const elapsed = Date.now() - animationStartedAt;
      const frame = currentAnimationFrame(animation, elapsed);
      setCurrentFrame(frame.spriteIndex);

      if (frame.delay !== null) {
        // Schedule next frame precisely
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        // Static frame, no more updates needed
        rafRef.current = undefined;
      }
    };

    tick();

    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current);
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
