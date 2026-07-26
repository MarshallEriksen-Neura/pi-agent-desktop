/**
 * Pet types — compatible with Codex pet.json manifest format
 */

export type PetState = 'idle' | 'running' | 'waiting' | 'review' | 'failed';

export interface AnimationSpec {
  frames: number[];
  fps?: number;
  loop?: boolean;
  fallback?: string;
}

export interface PetManifest {
  id?: string;
  displayName?: string;
  description?: string;
  spritesheetPath?: string;
  frame?: {
    width: number;
    height: number;
    columns: number;
    rows: number;
  };
  animations?: Record<string, AnimationSpec>;
}

export interface AnimationFrame {
  spriteIndex: number;
  duration: number; // milliseconds
}

export interface Animation {
  frames: AnimationFrame[];
  loopStart: number | null;
  fallback: string;
}

export interface Pet {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  frameCount: number;
  animations: Record<string, Animation>;
}

export interface BuiltinPet {
  id: string;
  displayName: string;
  description: string;
  spritesheetFile: string;
}

export interface PetStateUpdate {
  state: PetState;
  body?: string;
  timestamp: number;
}

/** Emitted by the main window when the user picks/disables a pet */
export interface PetConfigUpdate {
  petId: string | null;
}

// Codex default spritesheet dimensions
export const SPRITESHEET_WIDTH = 1536; // 192 * 8
export const SPRITESHEET_HEIGHT = 1872; // 208 * 9
export const DEFAULT_FRAME_WIDTH = 192;
export const DEFAULT_FRAME_HEIGHT = 208;
export const DEFAULT_COLUMNS = 8;
export const DEFAULT_ROWS = 9;
export const MAX_FPS = 60;
