/**
 * What `HEAD` points at, read straight off the filesystem.
 *
 * No `git` subprocess — and not for speed, since locally one would be fine. It
 * is because this has to answer for a *remote* project too, where the only thing
 * on offer is the launcher's file read. Running `git rev-parse` there would mean
 * a new launcher operation, which means a revision bump and every host
 * reinstalling its launcher before a branch name could appear. `.git/HEAD` is a
 * documented one-line file, and reading it is what shell prompts (starship,
 * powerlevel10k) do for the same reason.
 *
 * The limit is worth stating rather than discovering: this knows the current
 * branch and a detached object id. Ahead/behind counts, a dirty worktree and
 * "rebase in progress" are not in that file and would need real git.
 *
 * Paths are forward-slashed strings throughout, which is what the workspace
 * ports hand out on every platform — `fs_bridge` replaces separators on the way
 * through.
 */

/** Where a working tree's `HEAD` currently points. */
export type GitHead =
  | { kind: "branch"; name: string }
  | { kind: "detached"; sha: string };

/** Reads a file's text; rejects when it is absent or unreadable. */
export type GitFileReader = (path: string) => Promise<string>;

export interface GitHeadLocation {
  head: GitHead;
  /**
   * The `HEAD` file that answered. Kept so a later refresh is a single read
   * rather than a repeat of the search that found it.
   */
  headPath: string;
}

export interface ResolveGitHeadOptions {
  /**
   * How many ancestor directories to try when `root` holds no `.git` of its own.
   *
   * Non-zero locally, where a project opened at `monorepo/apps/web` should still
   * name its branch and a miss costs one failed `stat`. Zero on a remote target,
   * where every read is a fresh `ssh` process, so climbing would spend a
   * connection per level to usually learn nothing.
   */
  maxAncestors?: number;
}

const BRANCH_REF_PREFIX = "refs/heads/";

/** Loose on length: git is on sha-1 today and sha-256 in newer repositories. */
const OBJECT_ID = /^[0-9a-f]{7,64}$/i;

/**
 * Read one `HEAD` file, or null when it is not there / says nothing usable.
 *
 * A first line only: `HEAD` holds exactly one, and being strict about the rest
 * would mean a trailing newline decided whether a branch has a name.
 */
export function parseHead(text: string): GitHead | null {
  const line = firstLine(text);
  if (line.length === 0) return null;
  if (line.startsWith("ref:")) {
    const ref = line.slice("ref:".length).trim();
    if (ref.length === 0) return null;
    // A ref outside refs/heads/ is shown whole rather than dropped: HEAD can
    // legitimately point elsewhere (mid-bisect, or at a remote-tracking ref), and
    // the full ref reads better there than an empty space where a name goes.
    return {
      kind: "branch",
      name: ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref,
    };
  }
  return OBJECT_ID.test(line) ? { kind: "detached", sha: line } : null;
}

/**
 * The git directory a `.git` *file* points at, or null when the text is not one.
 *
 * `.git` is a file rather than a directory in a linked worktree and in a
 * submodule. Worth following: `git worktree add` is how a second branch of one
 * repository gets opened side by side with the first, and treating that as "not a
 * repository" would hide the branch exactly where two of them are in play.
 *
 * The recorded path may be relative — submodules get `../.git/modules/<name>` —
 * so the caller resolves it against the directory the pointer was read from.
 */
export function parseGitdirPointer(text: string): string | null {
  const line = firstLine(text);
  if (!line.startsWith("gitdir:")) return null;
  const target = line.slice("gitdir:".length).trim().replace(/\\/g, "/");
  return target.length > 0 ? target : null;
}

/** `HEAD` at an exact path. A missing or unreadable file is null, never a throw. */
export async function readGitHead(
  read: GitFileReader,
  path: string,
): Promise<GitHead | null> {
  const text = await readText(read, path);
  return text === null ? null : parseHead(text);
}

/**
 * Find the working tree `root` belongs to and report where its `HEAD` points.
 *
 * Null means "no git working tree here", which is the answer the branch label
 * hides for. Deliberately indistinguishable from an unreadable `.git`: a user
 * with no permission to read it has nothing to act on either way, and a broken
 * repository is not something a one-line label can usefully report.
 */
export async function resolveGitHead(
  read: GitFileReader,
  root: string,
  options: ResolveGitHeadOptions = {},
): Promise<GitHeadLocation | null> {
  const maxAncestors = options.maxAncestors ?? 0;
  let dir = normalize(root.replace(/\\/g, "/"));
  if (dir.length === 0) return null;
  for (let level = 0; level <= maxAncestors; level++) {
    const found = await headIn(read, dir, level === 0);
    if (found !== null) return found;
    const parent = parentOf(dir);
    if (parent === null) break;
    dir = parent;
  }
  return null;
}

/** What the label shows: the branch name, or a short id when HEAD is detached. */
export function gitHeadLabel(head: GitHead): string {
  return head.kind === "branch" ? head.name : head.sha.slice(0, 7);
}

async function headIn(
  read: GitFileReader,
  dir: string,
  followPointer: boolean,
): Promise<GitHeadLocation | null> {
  const direct = `${dir}/.git/HEAD`;
  const head = await readGitHead(read, direct);
  if (head !== null) return { head, headPath: direct };
  // Only at the directory that was opened. A worktree or submodule is opened at
  // its own root, and doing this at every ancestor would double the reads of the
  // climb to cover a case that does not arise.
  if (!followPointer) return null;
  const pointer = await readText(read, `${dir}/.git`);
  const gitdir = pointer === null ? null : parseGitdirPointer(pointer);
  if (gitdir === null) return null;
  const linked = `${resolveAgainst(dir, gitdir)}/HEAD`;
  const linkedHead = await readGitHead(read, linked);
  return linkedHead === null ? null : { head: linkedHead, headPath: linked };
}

async function readText(read: GitFileReader, path: string): Promise<string | null> {
  try {
    return await read(path);
  } catch {
    // Absent, a directory, or refused — all of them mean "look somewhere else".
    return null;
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

/** True for `/srv/app` and for `D:/repo` — the two shapes the ports produce. */
function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:\//i.test(path);
}

function resolveAgainst(base: string, target: string): string {
  return normalize(isAbsolute(target) ? target : `${base}/${target}`);
}

/**
 * Collapse `.`, `..` and repeated slashes. Enough for the paths git writes into a
 * `.git` pointer, and it keeps `..` that would climb past the start rather than
 * silently discarding it.
 */
function normalize(path: string): string {
  const rooted = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return (rooted ? "/" : "") + out.join("/");
}

/**
 * The containing directory, or null when there is nothing above worth reading.
 *
 * Stops at a filesystem root and at a Windows drive: a `.git` directly under `/`
 * or `D:/` is not a project anybody opened, and asking for it on a remote target
 * would spend a connection to find out.
 */
function parentOf(dir: string): string | null {
  const slash = dir.lastIndexOf("/");
  if (slash <= 0) return null;
  const parent = dir.slice(0, slash);
  return /^[a-z]:$/i.test(parent) ? null : parent;
}
