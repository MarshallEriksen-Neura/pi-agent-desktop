## Pet Spritesheets

Builtin pet spritesheets are downloaded from the Codex CDN on first use and cached in IndexedDB.

For local development/testing, you can place placeholder spritesheets here:

- `codex/spritesheet.webp` (1536×1872px, 8×9 grid of 192×208px frames)
- `dewey/spritesheet.webp`
- etc.

The actual production assets will be fetched from:
`https://persistent.oaistatic.com/codex/pets/v1/{pet-id}-spritesheet-v4.webp`

## Spritesheet Format

- **Total size**: 1536×1872 pixels
- **Frame size**: 192×208 pixels
- **Grid**: 8 columns × 9 rows = 72 frames
- **Rows** (animations):
  - Row 0: idle (6 frames)
  - Row 1: running-right (8 frames)
  - Row 2: running-left (8 frames)
  - Row 3: waving (4 frames)
  - Row 4: jumping (5 frames)
  - Row 5: failed/sad (8 frames)
  - Row 6: waiting (6 frames)
  - Row 7: running/working (6 frames)
  - Row 8: review/ready (6 frames)

## Custom Pets

Users can add custom pets by placing them in:
`~/.pi/pets/<pet-id>/`
  ├── pet.json
  └── spritesheet.webp

The pet.json manifest supports custom animation definitions. See Codex documentation for details.
