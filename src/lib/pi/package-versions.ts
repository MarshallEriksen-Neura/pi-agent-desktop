/**
 * Installed-vs-latest versions for npm plugin packages.
 *
 * settings.json records only the *source* (`npm:foo`, or `npm:foo@1.2.3` when
 * pinned), so the version actually on disk is not knowable from it — which is
 * why the row used to offer "Update" forever, with no way to tell a successful
 * update from a no-op.
 *
 * pi installs packages with npm into a scope-local tree (`~/.pi/agent/npm`
 * globally, `<root>/.pi/npm` for a project) whose `package-lock.json` carries
 * the resolved version of every entry. One read of that file covers every
 * package in the scope, so it is the installed-version source of truth rather
 * than N reads of `node_modules/<name>/package.json`.
 *
 * The latest published version comes from the registry's *abbreviated*
 * packument, which still carries `dist-tags` at a fraction of the full
 * document's size. `registry.npmjs.org` answers with `Access-Control-Allow-
 * Origin: *`, so unlike the skills.sh catalogue this can be fetched straight
 * from the renderer.
 */

const REGISTRY = "https://registry.npmjs.org";
const ABBREVIATED = "application/vnd.npm.install-v1+json";
const NODE_MODULES = "node_modules/";

/** `<scope root>/settings.json` → `<scope root>/npm/package-lock.json`. */
export function npmLockPath(settingsPath: string): string | null {
  const normalized = settingsPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return null;
  return `${normalized.slice(0, slash)}/npm/package-lock.json`;
}

/**
 * package name → resolved version for every top-level entry of an npm lock.
 *
 * Nested trees appear as `node_modules/a/node_modules/b`; only the top-level
 * install can be the one a settings entry refers to. Unparseable input yields
 * an empty map so a corrupt lock degrades to "version unknown" instead of
 * taking the page down.
 */
export function parseLockVersions(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let lock: unknown;
  try {
    lock = JSON.parse(raw);
  } catch {
    return out;
  }

  const entries = (lock as { packages?: Record<string, { version?: unknown }> } | null)?.packages;
  if (entries && typeof entries === "object") {
    for (const [key, entry] of Object.entries(entries)) {
      if (!key.startsWith(NODE_MODULES)) continue;
      const name = key.slice(NODE_MODULES.length);
      if (!name || name.includes(`/${NODE_MODULES}`)) continue;
      if (typeof entry?.version === "string" && entry.version) out.set(name, entry.version);
    }
    return out;
  }

  // lockfileVersion 1 kept resolved versions under `dependencies`
  const deps = (lock as { dependencies?: Record<string, { version?: unknown }> } | null)
    ?.dependencies;
  for (const [name, entry] of Object.entries(deps ?? {})) {
    if (typeof entry?.version === "string" && entry.version) out.set(name, entry.version);
  }
  return out;
}

interface Parsed {
  release: number[];
  /** dot-separated prerelease identifiers; empty for a plain release */
  pre: string[];
}

function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** semver precedence for the subset npm publishes: `x.y.z[-prerelease]`. */
function comparePre(a: string[], b: string[]): number {
  // a release outranks any prerelease of the same x.y.z
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left);
    const rightNum = /^\d+$/.test(right);
    if (leftNum && rightNum) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
    } else if (leftNum !== rightNum) {
      return leftNum ? -1 : 1; // numeric identifiers sort below alphanumeric
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1, or null when either side is not a version we understand. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    const l = left.release[i] ?? 0;
    const r = right.release[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

/**
 * Is `latest` strictly newer than `installed`?
 *
 * Fails closed on anything unrecognizable: an unknown shape reports "not
 * outdated", and the caller keeps offering the update button rather than
 * claiming a package is current on evidence it does not have.
 */
export function isOutdated(installed: string, latest: string): boolean {
  return compareVersions(installed, latest) === -1;
}

/** `@scope/name` has to survive as one path segment. */
function packumentUrl(name: string): string {
  return `${REGISTRY}/${name.replace("/", "%2F")}`;
}

/**
 * `dist-tags.latest` per package name. Missing entries mean "could not tell" —
 * a failed lookup must not read as "up to date".
 */
export async function fetchLatestVersions(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.allSettled(
    names.map(async (name) => {
      const response = await fetch(packumentUrl(name), { headers: { Accept: ABBREVIATED } });
      if (!response.ok) throw new Error(`npm registry: HTTP ${response.status} for ${name}`);
      const body = (await response.json()) as { "dist-tags"?: { latest?: unknown } };
      const latest = body["dist-tags"]?.latest;
      if (typeof latest === "string" && latest) out.set(name, latest);
    })
  );
  return out;
}
