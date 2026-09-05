export const LONG_TEXT_CHARACTER_THRESHOLD = 800;
export const LONG_TEXT_LINE_THRESHOLD = 12;

export interface LongTextStats {
  characters: number;
  lines: number;
}

/** Counts user-visible Unicode code points rather than UTF-16 code units. */
export function longTextStats(text: string): LongTextStats {
  if (!text) return { characters: 0, lines: 0 };
  const normalized = text.replace(/\r\n?/g, "\n");
  return {
    characters: Array.from(normalized).length,
    lines: normalized.split("\n").length,
  };
}

export function isLongText(text: string): boolean {
  const stats = longTextStats(text);
  return (
    stats.characters >= LONG_TEXT_CHARACTER_THRESHOLD ||
    stats.lines >= LONG_TEXT_LINE_THRESHOLD
  );
}

export function composeLongTextPrompt(documentText: string | null, instruction: string): string {
  const trimmedInstruction = instruction.trim();
  if (!documentText?.trim()) return trimmedInstruction;
  return trimmedInstruction ? `${documentText}\n\n${trimmedInstruction}` : documentText;
}

/** A one-line, non-lossy visual preview; the original text remains the source of truth. */
export function longTextPreview(text: string, maxCharacters = 96): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  if (characters.length <= maxCharacters) return compact;
  return `${characters.slice(0, maxCharacters).join("")}…`;
}
