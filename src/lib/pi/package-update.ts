const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const EXACT_SEMVER = /^(?:v)?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type PackageSourceKind = "npm" | "git" | "local";
export type PackageUpdateMode = "update" | "npm-pinned" | "git-pinned" | "local";

export interface PackageSourceInfo {
  kind: PackageSourceKind;
  name: string;
  identity: string;
  version?: string;
  ref?: string;
  updateMode: PackageUpdateMode;
}

export interface PackageUpdateRequest {
  args: string[];
  cwd: string | null;
}

function parseNpmSource(source: string): PackageSourceInfo | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice(4).trim();
  const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
  const name = match?.[1] ?? spec;
  const version = match?.[2];
  return {
    kind: "npm",
    name,
    identity: `npm:${name}`,
    version,
    updateMode: version && EXACT_SEMVER.test(version) ? "npm-pinned" : "update",
  };
}

function splitGitRef(source: string): { repo: string; ref?: string } {
  const scp = source.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const path = scp[2] ?? "";
    const separator = path.indexOf("@");
    if (separator > 0 && separator < path.length - 1) {
      return {
        repo: `git@${scp[1]}:${path.slice(0, separator)}`,
        ref: path.slice(separator + 1),
      };
    }
    return { repo: source };
  }

  if (source.includes("://")) {
    try {
      const url = new URL(source);
      const path = url.pathname.replace(/^\/+/, "");
      const separator = path.indexOf("@");
      if (separator > 0 && separator < path.length - 1) {
        url.pathname = `/${path.slice(0, separator)}`;
        return {
          repo: url.toString().replace(/\/$/, ""),
          ref: path.slice(separator + 1),
        };
      }
      return { repo: source };
    } catch {
      return { repo: source };
    }
  }

  const slash = source.indexOf("/");
  if (slash > 0) {
    const path = source.slice(slash + 1);
    const separator = path.indexOf("@");
    if (separator > 0 && separator < path.length - 1) {
      return {
        repo: `${source.slice(0, slash)}/${path.slice(0, separator)}`,
        ref: path.slice(separator + 1),
      };
    }
  }
  return { repo: source };
}

function gitIdentity(repo: string): { identity: string; name: string } | null {
  const scp = repo.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    const host = (scp[1] ?? "").toLowerCase();
    const path = (scp[2] ?? "").replace(/\.git$/i, "").replace(/\/$/, "");
    return host && path ? { identity: `git:${host}/${path}`, name: `${host}/${path}` } : null;
  }

  if (repo.includes("://")) {
    try {
      const url = new URL(repo);
      const host = url.hostname.toLowerCase();
      const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/$/, "");
      return host && path ? { identity: `git:${host}/${path}`, name: `${host}/${path}` } : null;
    } catch {
      return null;
    }
  }

  const slash = repo.indexOf("/");
  if (slash <= 0) return null;
  const host = repo.slice(0, slash).toLowerCase();
  const path = repo.slice(slash + 1).replace(/\.git$/i, "").replace(/\/$/, "");
  return host && path ? { identity: `git:${host}/${path}`, name: `${host}/${path}` } : null;
}

/** Classify a settings source without rewriting it. */
export function packageSourceInfo(source: string): PackageSourceInfo {
  const npm = parseNpmSource(source);
  if (npm) return npm;

  const rawGit = source.startsWith("git:") ? source.slice(4).trim() : source;
  const isGit = source.startsWith("git:") || /^(?:https?|ssh|git):\/\//i.test(source);
  if (isGit) {
    const { repo, ref } = splitGitRef(rawGit);
    const parsed = gitIdentity(repo);
    if (parsed) {
      return {
        kind: "git",
        name: parsed.name,
        identity: parsed.identity,
        ref,
        updateMode: ref ? "git-pinned" : "update",
      };
    }
  }

  return {
    kind: "local",
    name: source,
    identity: `local:${source}`,
    updateMode: "local",
  };
}

function safeUpdateSource(source: string): boolean {
  return Boolean(source.trim()) && !source.trimStart().startsWith("-") && !CONTROL_CHARACTER.test(source);
}

/** Update the matching package identity in the current PI settings context. */
export function packageUpdateRequest(
  source: string,
  projectRoot: string | null
): PackageUpdateRequest | null {
  if (!safeUpdateSource(source)) return null;
  return { args: ["update", source], cwd: projectRoot };
}

/** Update all packages visible in the current PI settings context, not PI itself. */
export function packageUpdateAllRequest(projectRoot: string | null): PackageUpdateRequest {
  return { args: ["update", "--extensions"], cwd: projectRoot };
}
