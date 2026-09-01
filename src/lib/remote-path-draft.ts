/**
 * The typed path in the remote folder picker, as pure functions of the draft string.
 *
 * Separate from the component because this is the part with actual decisions in it and
 * no way to see them in a screenshot: which directory a half-typed path refers to, and
 * which entry a keystroke completes to. A wrong answer here spends an SSH round trip on
 * the wrong directory, so it is worth testing directly.
 *
 * POSIX-absolute throughout. The launcher rejects anything that does not start with `/`
 * (`validPath` in `remote-launcher/pi-desktop-launcher`), so there is no Windows path
 * shape to consider even when the desktop itself is Windows.
 */

const SEPARATOR = "/";

export interface RemoteDraftLocation {
  /** The absolute directory the suggestions should be listed from. */
  dir: string;
  /**
   * The trailing segment still being typed. Filters `dir`'s listing and is never
   * listed itself — `/srv/ap` means "inside /srv, the ones starting ap", not "list
   * /srv/ap", which is the whole reason a draft splits into two parts.
   */
  filter: string;
}

/**
 * `~` and `~/x`, when the host's `$HOME` is known.
 *
 * Expanded on the desktop rather than sent through: the launcher takes absolute paths
 * only and never runs a shell, so an unexpanded `~` reaches it as a literal directory
 * name. `~user` is left alone — resolving another account's home needs the remote
 * passwd database, which nothing here has.
 */
export function expandRemoteTilde(draft: string, home?: string | null): string {
  if (typeof home !== "string" || !home.startsWith(SEPARATOR)) return draft;
  if (draft === "~") return home;
  if (!draft.startsWith("~/")) return draft;
  return home.replace(/\/+$/, "") + draft.slice(1);
}

/**
 * Collapse `//`, `.`, `..` and any trailing slash. Always returns an absolute path.
 *
 * Lexical, not physical: `/a/link/..` resolves to `/a` here, while the kernel would
 * resolve it through the link. The `..` row in the picker has always worked this way,
 * and the alternative — sending `..` verbatim — means the path that gets *committed* as
 * a project root still contains it.
 */
export function normalizeRemoteDir(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split(SEPARATOR)) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return SEPARATOR + segments.join(SEPARATOR);
}

/**
 * Where a draft points: the directory to list, and the filter within it.
 *
 * `null` when the draft is not absolute yet — a user who has typed `sr` has not named a
 * directory anywhere, and guessing one (the loaded directory? `$HOME`?) would list
 * somewhere they did not ask for.
 */
export function splitRemoteDraft(
  draft: string,
  home?: string | null,
): RemoteDraftLocation | null {
  const expanded = expandRemoteTilde(draft.trim(), home);
  if (!expanded.startsWith(SEPARATOR)) return null;
  // The last separator is the split point, so a trailing slash yields an empty filter —
  // which is what makes "typed my way into a directory" and "chose it from the list"
  // land in the same state.
  const cut = expanded.lastIndexOf(SEPARATOR);
  return {
    dir: normalizeRemoteDir(expanded.slice(0, cut + 1)),
    filter: expanded.slice(cut + 1),
  };
}

/** The whole draft as one path — what Enter opens and what the button commits. */
export function resolveRemoteDraftPath(draft: string, home?: string | null): string | null {
  const expanded = expandRemoteTilde(draft.trim(), home);
  if (!expanded.startsWith(SEPARATOR)) return null;
  return normalizeRemoteDir(expanded);
}

/**
 * `entries` narrowed to `filter`, prefix matches first.
 *
 * Case-insensitive even though remote paths are not: this only decides what is
 * *offered*, and every candidate is a real entry whose own exact path is what gets
 * opened, so a lenient filter cannot produce a path that does not exist. Prefix before
 * substring because the prefix match is what someone typing a name is aiming at.
 *
 * Only ever sees the listing the launcher returned, which is capped at
 * `MAX_WORKSPACE_ENTRIES` — in a directory past that cap, a filter cannot reach the
 * names beyond the sorted prefix. Typing more of the path and letting it list the
 * deeper directory still works.
 */
export function filterRemoteEntries<T extends { name: string }>(
  entries: readonly T[],
  filter: string,
): T[] {
  if (filter.length === 0) return [...entries];
  const needle = filter.toLowerCase();
  const prefixed: T[] = [];
  const contained: T[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    if (name.startsWith(needle)) prefixed.push(entry);
    else if (name.includes(needle)) contained.push(entry);
  }
  return [...prefixed, ...contained];
}

/**
 * The draft text for "now inside `dir`".
 *
 * Trailing slash on purpose: it is what tells {@link splitRemoteDraft} to list `dir`
 * rather than treat its name as a filter in the parent, and it leaves the caret where
 * the next segment gets typed.
 */
export function draftForDir(dir: string): string {
  return dir === SEPARATOR ? SEPARATOR : `${normalizeRemoteDir(dir)}${SEPARATOR}`;
}
