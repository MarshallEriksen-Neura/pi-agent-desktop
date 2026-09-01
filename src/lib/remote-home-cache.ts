/**
 * Remembers each remote host's `$HOME`, so a folder browser has somewhere to open.
 *
 * The launcher only accepts absolute paths and the desktop cannot expand `$HOME`
 * locally, so a first browse would otherwise have to start at `/` — which on a typical
 * host is a wall of `bin`, `boot`, `dev`… with the user's projects nowhere in sight.
 *
 * Preflight already reports it, and preflight already runs before a target switch and
 * on every settings check. This just keeps the answer instead of paying a second
 * 30-second-timeout round trip to ask again.
 *
 * Deliberately in-memory and unpersisted: `$HOME` is a fact about a live host, and a
 * stale one written to disk would send the browser somewhere that no longer exists
 * with no way to tell. Losing it on restart costs nothing — the next preflight refills
 * it, and until then the browser falls back.
 */

const homes = new Map<string, string>();

/** Absolute POSIX only; anything else is not a path the launcher would accept. */
function isUsable(home: string | null | undefined): home is string {
  return (
    typeof home === "string" &&
    home.startsWith("/") &&
    home.length <= 4096 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(home)
  );
}

export function rememberRemoteHome(profileId: string, home: string | null | undefined): void {
  if (!profileId || !isUsable(home)) return;
  homes.set(profileId, home);
}

export function remoteHome(profileId: string): string | undefined {
  return homes.get(profileId);
}

export function forgetRemoteHome(profileId: string): void {
  homes.delete(profileId);
}

/** Test seam. */
export function clearRemoteHomes(): void {
  homes.clear();
}
