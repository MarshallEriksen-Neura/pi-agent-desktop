"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import type { Pet, PetState } from "@/lib/pet/types";
import { stateToAnimation } from "@/lib/pet/state-lifetimes";
import { currentAnimationFrame } from "@/lib/pet/animator";

interface PetSpriteProps {
  pet: Pet;
  state: PetState;
  animationStartedAt: number;
  bubble?: string | null;
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

  if (broken) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl bg-indigo-500/80 text-white text-xs font-medium px-3 py-2 ${className}`}
        style={{ width: pet.frameWidth, height: pet.frameHeight }}
      >
        {pet.displayName}
        <span className="ml-1 opacity-70">(sprite missing)</span>
      </div>
    );
  }

  return (
    <div className={`relative ${className}`}>
      {/* Sprite */}
      <div
        className="pixelated"
        style={{
          ...spriteStyle,
          imageRendering: "pixelated",
        }}
      />

      {/* Bubble */}
      {bubble && (
        <div
          className="absolute -top-12 left-1/2 -translate-x-1/2
                     bg-white/90 dark:bg-gray-800/90 backdrop-blur-sm
                     px-3 py-1.5 rounded-lg text-xs font-medium
                     shadow-lg whitespace-nowrap max-w-[200px] truncate
                     border border-gray-200 dark:border-gray-700"
        >
          {bubble}
        </div>
      )}
    </div>
  );
}
