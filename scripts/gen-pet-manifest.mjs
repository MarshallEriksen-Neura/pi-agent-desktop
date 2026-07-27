/**
 * gen-pet-manifest.mjs
 * Build-time script: scan public/pets/builtin/ and emit public/pets/builtin/manifest.json
 * Run automatically via predev / prebuild npm hooks.
 */

import { readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const builtinDir = join(process.cwd(), 'public', 'pets', 'builtin');

if (!existsSync(builtinDir)) {
  console.warn('[gen-pet-manifest] public/pets/builtin/ not found, skipping.');
  process.exit(0);
}

const pets = readdirSync(builtinDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .filter((d) => existsSync(join(builtinDir, d.name, 'pet.json')))
  .map((d) => {
    const raw = readFileSync(join(builtinDir, d.name, 'pet.json'), 'utf-8');
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      console.warn(`[gen-pet-manifest] Skipping ${d.name}: invalid pet.json`);
      return null;
    }
    return {
      id: d.name,
      displayName: (manifest.displayName ?? d.name).trim(),
      description: (manifest.description ?? '').trim(),
      // cdnFile is optional — only needed if this pet has a CDN spritesheet fallback
      ...(manifest.cdnFile ? { cdnFile: manifest.cdnFile } : {}),
    };
  })
  .filter(Boolean);

const manifest = { pets };
writeFileSync(
  join(builtinDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);

console.log(
  `[gen-pet-manifest] ${pets.length} pet(s) → public/pets/builtin/manifest.json`
);
