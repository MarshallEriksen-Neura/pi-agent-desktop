import type { SettingsScope } from "./settings";

const PREFIXED_SOURCE = /^(npm|git):(.*)$/i;
const URL_SOURCE = /^(https?|ssh|git):\/\//i;
const SCP_GIT_SOURCE = /^git@[^:\s]+:.+/i;
const LOCAL_SOURCE = /^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[a-z]:[\\/]|\\\\)/i;
const RELATIVE_LOCAL_SOURCE = /^\.{1,2}[\\/]/;
const NPM_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[^\s]+)?$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function validUrlSource(source: string): boolean {
  if (/\s/.test(source)) return false;
  try {
    const url = new URL(source);
    return Boolean(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Normalize the package source spellings Pi accepts without guessing at an
 * unsupported repository shorthand. A bare valid package spec means npm.
 */
export function normalizePackageSource(raw: string): string | null {
  const source = raw.trim();
  if (!source || source.startsWith("-") || CONTROL_CHARACTER.test(source)) return null;

  const prefixed = source.match(PREFIXED_SOURCE);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const value = prefixed[2].trim();
    if (!value || value.startsWith("-")) return null;
    if (kind === "npm" && !NPM_SPEC.test(value)) return null;
    return `${kind}:${value}`;
  }

  if (URL_SOURCE.test(source)) return validUrlSource(source) ? source : null;
  if (LOCAL_SOURCE.test(source)) return source;
  if (SCP_GIT_SOURCE.test(source)) return `git:${source}`;
  if (NPM_SPEC.test(source)) return `npm:${source}`;
  return null;
}

export function packageInstallArgs(source: string, scope: SettingsScope): string[] {
  return scope === "project" ? ["install", source, "-l"] : ["install", source];
}

export interface PackageInstallRequest {
  args: string[];
  cwd: string | null;
}

/** Lock argv and cwd to the workspace observed when the user submitted. */
export function packageInstallRequest(
  source: string,
  scope: SettingsScope,
  projectRoot: string | null
): PackageInstallRequest | null {
  if (scope === "project" && !projectRoot) return null;
  if (RELATIVE_LOCAL_SOURCE.test(source) && !projectRoot) return null;
  return { args: packageInstallArgs(source, scope), cwd: projectRoot };
}
