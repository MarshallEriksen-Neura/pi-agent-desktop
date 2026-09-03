export interface ParsedSourceSkill {
  name: string;
  description: string;
}

/** CSI sequences emitted by the Skills CLI's clack renderer. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");

/**
 * Parse `skills add <source> --list` across the observed clack format and the
 * older markdown-style bullet format. The CLI does not expose JSON output.
 */
export function parseSkillList(stdout: string): ParsedSourceSkill[] {
  const lines = stdout.replace(ANSI, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes("Available Skills"));
  if (start < 0) return [];

  const skills: ParsedSourceSkill[] = [];
  for (const line of lines.slice(start + 1)) {
    const bullet = /^\s*[-*]\s+([^\s:]+)(?::\s*(.*))?$/.exec(line);
    if (bullet) {
      skills.push({ name: bullet[1]!, description: bullet[2] ?? "" });
      continue;
    }

    const clack = /^[│|](\s+)(\S.*?)\s*$/.exec(line);
    if (!clack) continue;
    if (clack[1]!.length <= 5) {
      skills.push({ name: clack[2]!, description: "" });
    } else if (skills.length > 0) {
      skills[skills.length - 1]!.description = clack[2]!;
    }
  }
  return skills;
}
