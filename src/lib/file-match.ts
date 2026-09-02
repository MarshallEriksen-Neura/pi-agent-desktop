"use client";

/**
 * `@`-mention matching for the composer, ported from pi's own TUI completion.
 *
 * Deliberately a port rather than a fuzzy-search dependency. pi already ships this
 * exact feature (`docs/usage.md`: "Type @ to fuzzy-search project files"), and a
 * different algorithm here would rank the same query differently in the two places
 * the same person uses interchangeably. The token rules below — the delimiter set,
 * the quoting, the scoring weights — are pi's, so a path completed here is the path
 * pi's own editor would have completed.
 *
 * pi does **not** expand `@path` when a message is sent: `<file name="…">…</file>`
 * is produced only by its CLI argument path (`processFileArguments`), never by the
 * RPC `prompt` command this app speaks. So a mention is a *reference* the model
 * reads with its own tool, not an attachment — which is why nothing here touches
 * file contents.
 */

/**
 * Characters that end a path token. pi's `PATH_DELIMITERS`, and notably *not* `/`
 * — a slash is part of the path being completed, which is what lets `@src/lib/st`
 * keep matching after the user types the separator.
 */
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

export interface FuzzyMatch {
  matches: boolean;
  /** Lower is better. Negative scores are strong matches. */
  score: number;
}

/**
 * Score `query` against `text`, subsequence-style.
 *
 * Word boundaries and runs of consecutive characters are rewarded (they subtract
 * from the score), gaps and late positions are penalised, and an exact match is
 * pushed far ahead of everything else. Callers sort **ascending**.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  if (queryLower.length === 0) return { matches: true, score: 0 };
  if (queryLower.length > textLower.length) return { matches: false, score: 0 };

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -1;
  let consecutive = 0;

  for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
    if (textLower[i] !== queryLower[queryIndex]) continue;
    const atWordBoundary = i === 0 || /[\s\-_./:]/.test(textLower[i - 1]);
    if (lastMatchIndex === i - 1) {
      consecutive++;
      score -= consecutive * 5;
    } else {
      consecutive = 0;
      if (lastMatchIndex >= 0) score += (i - lastMatchIndex - 1) * 2;
    }
    if (atWordBoundary) score -= 10;
    score += i * 0.1;
    lastMatchIndex = i;
    queryIndex++;
  }

  if (queryIndex < queryLower.length) return { matches: false, score: 0 };
  if (queryLower === textLower) score -= 100;
  return { matches: true, score };
}

/**
 * Rank `paths` against `query`, best first.
 *
 * The query is split on whitespace *and* slashes and every token has to match, so
 * `lib store` and `lib/store` both find `src/lib/store.ts` — typing the separator
 * narrows the search instead of restarting it.
 */
export function rankPaths(query: string, paths: readonly string[], limit: number): string[] {
  const tokens = query.trim().split(/[\s/]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return paths.slice(0, limit);

  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    let total = 0;
    let all = true;
    for (const token of tokens) {
      const match = fuzzyMatch(token, path);
      if (!match.matches) {
        all = false;
        break;
      }
      total += match.score;
    }
    if (all) scored.push({ path, score: total });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((entry) => entry.path);
}

export interface MentionToken {
  /** Index of the `@` in the draft. */
  start: number;
  /** Index just past the token — always the caret, never further. */
  end: number;
  /** What to match on: the token minus `@` and any opening quote. */
  query: string;
  /** The token opened with `@"`, so the completion has to close the quote. */
  quoted: boolean;
}

/**
 * The `@`-token the caret sits in, or null.
 *
 * Caret-based rather than draft-based, unlike the slash menu (which is anchored to
 * `draft.startsWith("/")`): a mention can appear anywhere in a sentence, so the
 * only way to know which token is being typed is to scan left from the caret. This
 * is also why the composer has to track selection changes and not just the text.
 *
 * `end` is the caret and not the end of the word on purpose — completing from the
 * middle of an existing path would rewrite text to the right of the cursor that the
 * user never asked about.
 */
export function mentionTokenAt(draft: string, caret: number): MentionToken | null {
  const end = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, end);
  const isTokenStart = (index: number) =>
    index === 0 || PATH_DELIMITERS.has(before[index - 1]);

  // An open quote wins over the delimiter scan below, because a quoted mention
  // contains delimiters by definition — `@"src/my dir/` would otherwise be cut at
  // its own space and complete against `dir/` alone.
  const quoteStart = unclosedQuoteStart(before);
  if (quoteStart !== null) {
    const opensWithAt = quoteStart > 0 && before[quoteStart - 1] === "@";
    if (!opensWithAt || !isTokenStart(quoteStart - 1)) return null;
    return {
      start: quoteStart - 1,
      end,
      query: before.slice(quoteStart + 1),
      quoted: true,
    };
  }

  let start = end;
  while (start > 0 && !PATH_DELIMITERS.has(before[start - 1])) start--;
  // `a@b.com` is an email, not a mention: the `@` has to open the token, which the
  // scan above guarantees by stopping at the delimiter before it.
  if (before[start] !== "@") return null;
  return { start, end, query: before.slice(start + 1), quoted: false };
}

/** Index of the `"` that is still open at the end of `text`, if any. */
function unclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '"') continue;
    inQuotes = !inQuotes;
    if (inQuotes) start = i;
  }
  return inQuotes ? start : null;
}

/**
 * The text a picked path becomes: `@path`, or `@"path"` when it contains a space.
 *
 * pi's `buildCompletionValue`. The quotes are not decoration — they are what keeps
 * a path with a space in it a single token under the delimiter rules above, so
 * re-editing the mention later still finds the whole thing.
 *
 * `open` leaves a quoted value unterminated. Completing a *directory* is not the
 * end of a mention — the user is drilling down — so closing the quote there would
 * end the token they are still typing and shut the menu on them.
 */
export function buildMentionValue(
  path: string,
  { quoted, open }: { quoted: boolean; open: boolean },
): string {
  if (!quoted && !path.includes(" ")) return `@${path}`;
  return open ? `@"${path}` : `@"${path}"`;
}

/** Trailing `/` marks a directory — see `FileIndex::paths` in the Rust walk. */
export function isDirectoryPath(path: string): boolean {
  return path.endsWith("/");
}

/** `src/lib/store.ts` → `store.ts`; `src/lib/` → `lib`. */
export function pathLeaf(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** `src/lib/store.ts` → `src/lib`; a top-level path has no parent to show. */
export function pathParent(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? "" : trimmed.slice(0, slash);
}

/**
 * `path` relative to `root`, or `path` unchanged when it is not underneath it.
 *
 * Mentions are relative because that is what pi resolves against its own cwd, and
 * because it sidesteps path translation entirely: under WSL the same file is
 * `D:/repo/src` to this window and `/mnt/d/repo/src` to pi, and a relative path is
 * correct on both sides without consulting the runtime mode.
 */
export function relativeToRoot(path: string, root: string | null): string {
  if (!root) return path;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (!normalizedRoot) return normalized;
  if (normalized === normalizedRoot) return "";
  return normalized.startsWith(`${normalizedRoot}/`)
    ? normalized.slice(normalizedRoot.length + 1)
    : normalized;
}
