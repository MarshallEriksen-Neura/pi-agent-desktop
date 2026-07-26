/**
 * Pet manifest loading and validation
 */

import type { Pet, PetManifest, AnimationSpec, Animation, AnimationFrame } from './types';
import {
  SPRITESHEET_WIDTH,
  SPRITESHEET_HEIGHT,
  DEFAULT_FRAME_WIDTH,
  DEFAULT_FRAME_HEIGHT,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  MAX_FPS,
} from './types';
import { defaultAnimations } from './animations';

export class PetLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PetLoadError';
  }
}

/**
 * Load and validate a pet manifest from JSON
 */
export async function loadPetManifest(
  manifestPath: string,
  spritesheetBasePath: string
): Promise<Pet> {
  let manifest: PetManifest;
  try {
    const response = await fetch(manifestPath);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    manifest = await response.json();
  } catch (e) {
    throw new PetLoadError(
      `Failed to load manifest: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const id = manifest.id?.trim() || 'pet';
  const displayName = manifest.displayName?.trim() || manifest.id?.trim() || id;
  const description = manifest.description?.trim() || '';

  const spritesheetPath =
    spritesheetBasePath +
    '/' +
    (manifest.spritesheetPath?.trim() || 'spritesheet.webp');

  // Validate spritesheet path doesn't escape
  if (
    manifest.spritesheetPath &&
    (manifest.spritesheetPath.includes('..') ||
      manifest.spritesheetPath.startsWith('/'))
  ) {
    throw new PetLoadError('Spritesheet path must not escape pet directory');
  }

  const frame = manifest.frame || {
    width: DEFAULT_FRAME_WIDTH,
    height: DEFAULT_FRAME_HEIGHT,
    columns: DEFAULT_COLUMNS,
    rows: DEFAULT_ROWS,
  };

  if (
    frame.width <= 0 ||
    frame.height <= 0 ||
    frame.columns <= 0 ||
    frame.rows <= 0
  ) {
    throw new PetLoadError('Frame dimensions must be positive');
  }

  const totalWidth = frame.width * frame.columns;
  const totalHeight = frame.height * frame.rows;
  if (totalWidth !== SPRITESHEET_WIDTH || totalHeight !== SPRITESHEET_HEIGHT) {
    throw new PetLoadError(
      `Frame grid must cover ${SPRITESHEET_WIDTH}×${SPRITESHEET_HEIGHT} exactly, got ${totalWidth}×${totalHeight}`
    );
  }

  const frameCount = frame.columns * frame.rows;
  if (frameCount > 256) {
    throw new PetLoadError(`Frame count ${frameCount} exceeds maximum 256`);
  }

  const animations = manifest.animations
    ? loadAnimations(manifest.animations, frameCount)
    : defaultAnimations();

  return {
    id,
    displayName,
    description,
    spritesheetPath,
    frameWidth: frame.width,
    frameHeight: frame.height,
    columns: frame.columns,
    rows: frame.rows,
    frameCount,
    animations,
  };
}

function loadAnimations(
  specs: Record<string, AnimationSpec>,
  frameCount: number
): Record<string, Animation> {
  const animations = defaultAnimations();

  for (const [name, spec] of Object.entries(specs)) {
    if (!spec.frames || spec.frames.length === 0) {
      throw new PetLoadError(`Animation ${name} must have at least one frame`);
    }

    for (const idx of spec.frames) {
      if (idx < 0 || idx >= frameCount) {
        throw new PetLoadError(
          `Animation ${name} frame index ${idx} out of range [0, ${frameCount})`
        );
      }
    }

    const fps = spec.fps ?? 8;
    if (!Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
      throw new PetLoadError(
        `Animation ${name} fps must be between 0 and ${MAX_FPS}, got ${fps}`
      );
    }

    const duration = 1000 / fps;
    const fallback = spec.fallback?.trim() || 'idle';
    const loop = spec.loop ?? true;

    animations[name] = {
      frames: spec.frames.map((spriteIndex: number) => ({ spriteIndex, duration })),
      loopStart: loop ? 0 : null,
      fallback,
    };
  }

  // Ensure idle exists
  if (!animations.idle) {
    animations.idle = {
      frames: [{ spriteIndex: 0, duration: 1000 }],
      loopStart: 0,
      fallback: 'idle',
    };
  }

  // Validate fallback chains
  for (const [name, anim] of Object.entries(animations)) {
    if (!animations[anim.fallback]) {
      throw new PetLoadError(
        `Animation ${name} fallback "${anim.fallback}" does not exist`
      );
    }
  }

  return animations;
}

/**
 * Validate spritesheet dimensions without loading the full image
 */
export async function validateSpritesheet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (
        img.naturalWidth !== SPRITESHEET_WIDTH ||
        img.naturalHeight !== SPRITESHEET_HEIGHT
      ) {
        reject(
          new PetLoadError(
            `Spritesheet must be ${SPRITESHEET_WIDTH}×${SPRITESHEET_HEIGHT}px, got ${img.naturalWidth}×${img.naturalHeight}px`
          )
        );
      } else {
        resolve();
      }
    };
    img.onerror = () => reject(new PetLoadError('Failed to load spritesheet'));
    img.src = url;
  });
}
