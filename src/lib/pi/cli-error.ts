import type { CliResultDto } from "../backend/ports";

/** CSI sequences, spelled without a literal escape byte in the source. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g");
/** clack's gutter and status glyphs, which carry no information here. */
const GUTTER = /^[│|■◆◇◒◐◓◑●○└┌├─]+\s*/;
/** npx/npm chatter about the user's environment, not the failed action. */
const NPM_NOISE = /^npm (warn|WARN|notice)\b/;
/** clack outros that only repeat that something went wrong. */
const OUTRO = /^(Installation failed|Removal failed|Update failed|Canceled|Cancelled)$/;

/** Reduce CLI output to the last useful diagnostic that fits in a settings row. */
export function cliError(result: CliResultDto, fallback: string): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.replace(GUTTER, "").trim())
    .filter(
      (line) =>
        line &&
        !NPM_NOISE.test(line) &&
        !OUTRO.test(line) &&
        !line.startsWith("Tip:") &&
        !line.includes("…")
    );
  return lines.slice(-3).join(" · ").slice(-400) || fallback;
}
