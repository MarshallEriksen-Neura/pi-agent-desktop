/**
 * Built-in pet catalog — ported from Codex TUI
 */

import type { BuiltinPet } from './types';

export const BUILTIN_PETS: BuiltinPet[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    description: 'The original Codex companion',
    spritesheetFile: 'codex-spritesheet-v4.webp',
  },
  {
    id: 'dewey',
    displayName: 'Dewey',
    description: 'A tidy duck for calm workspace days',
    spritesheetFile: 'dewey-spritesheet-v4.webp',
  },
  {
    id: 'fireball',
    displayName: 'Fireball',
    description: 'Hot path energy for fast iteration',
    spritesheetFile: 'fireball-spritesheet-v4.webp',
  },
  {
    id: 'rocky',
    displayName: 'Rocky',
    description: 'A steady rock when the diff gets large',
    spritesheetFile: 'rocky-spritesheet-v4.webp',
  },
  {
    id: 'seedy',
    displayName: 'Seedy',
    description: 'Small green shoots for new ideas',
    spritesheetFile: 'seedy-spritesheet-v4.webp',
  },
  {
    id: 'stacky',
    displayName: 'Stacky',
    description: 'A balanced stack for deep work',
    spritesheetFile: 'stacky-spritesheet-v4.webp',
  },
  {
    id: 'bsod',
    displayName: 'BSOD',
    description: 'A tiny blue-screen gremlin',
    spritesheetFile: 'bsod-spritesheet-v4.webp',
  },
  {
    id: 'null-signal',
    displayName: 'Null Signal',
    description: 'Quiet signal from the void',
    spritesheetFile: 'null-signal-spritesheet-v4.webp',
  },
];

export function getBuiltinPet(id: string): BuiltinPet | null {
  return BUILTIN_PETS.find((p) => p.id === id) ?? null;
}

export const CDN_BASE_URL = 'https://persistent.oaistatic.com/codex/pets/v1';
