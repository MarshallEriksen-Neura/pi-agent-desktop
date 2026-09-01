import type { ProjectCatalogPort } from "../ports";
import type { RecentProject } from "../../workspace";
import type { LauncherUpgradeResult } from "../ports/execution-target";
import type { FsEntryDto } from "../ports/workspace-fs";
import { LOCAL_WORKSPACE_TARGET, type WorkspaceTargetId } from "../../workspace-target";
import { remoteHome } from "../../remote-home-cache";
import { desktopInvoke } from "./invoke";
import { desktopRemotePiProfilePort } from "./remote-profiles";
import { createDesktopRemoteWorkspaceFsPort } from "./remote-workspace-fs";

/** `ssh:<profileId>` is the only remote execution target shape. */
function profileIdOf(targetId: WorkspaceTargetId): string {
  const profileId = targetId.startsWith("ssh:") ? targetId.slice(4) : "";
  if (profileId.length === 0) {
    throw new Error(`not a remote execution target: ${targetId}`);
  }
  return profileId;
}

/**
 * Profiles whose launcher has been settled this session.
 *
 * Per session rather than persisted: the answer depends on what is installed on the
 * host right now, and a cache that outlived the app would confidently skip a host
 * somebody downgraded by hand. Only *settled* outcomes are recorded — a host that
 * could not be probed is retried, because "unreachable" is a statement about the
 * network a moment ago, not about the host.
 */
const launcherSettled = new Set<string>();

/** Exposed for tests; the session cache is module state by design. */
export function resetLauncherSettledForTest(): void {
  launcherSettled.clear();
}

/**
 * Bring a host's launcher up to this build before using a mode it might not have.
 *
 * Called on the way into browsing because that is where the gap actually bites: a
 * launcher predating `--workspace` fails at the point of use with a transport error,
 * and nothing else in the app was checking. Never throws — an upgrade that could not
 * happen must not stop the browse, which either works anyway or fails with its own
 * far better message.
 *
 * `upgrade` is injectable for the same reason the workspace port's is: the interesting
 * behaviour here is *what gets cached*, and that is untestable against a real invoke.
 */
export async function ensureLauncherCurrent(
  profileId: string,
  upgrade: (id: string) => Promise<LauncherUpgradeResult> = (id) =>
    desktopRemotePiProfilePort.autoUpgradeLauncher(id),
): Promise<void> {
  if (launcherSettled.has(profileId)) return;
  try {
    const result = await upgrade(profileId);
    // `unreachable` stays uncached so a host that comes back gets another chance. Every
    // settled answer is cached, including `blocked_by_live_tasks` — retrying that on
    // each browse would spend two SSH round trips to re-learn a decision that cannot
    // change until the user's tasks finish.
    if (result.outcome !== "unreachable") launcherSettled.add(profileId);
  } catch {
    // A missing command on an older build, or a profile deleted mid-flight. Both are
    // survivable here: the browse below is what the user asked for. Deliberately not
    // cached — a thrown call established nothing about the host.
  }
}

export const desktopProjectCatalogPort: ProjectCatalogPort = {
  resolve: (path: string) => desktopInvoke<string>("project_resolve", { path }),
  commit: (path: string) => desktopInvoke<string>("project_open", { path }),
  pick: () => desktopInvoke<string | null>("project_pick"),
  listRecent: () => desktopInvoke<RecentProject[]>("projects_recent"),
  removeRecent: (path: string, targetId: WorkspaceTargetId = LOCAL_WORKSPACE_TARGET) =>
    desktopInvoke<RecentProject[]>("project_remove_recent", { path, targetId }),
  commitRemote: (path: string, targetId: WorkspaceTargetId) =>
    desktopInvoke<RecentProject[]>("project_open_remote", { path, targetId }),

  async browse(targetId: WorkspaceTargetId, startingPath?: string) {
    if (targetId === LOCAL_WORKSPACE_TARGET) {
      // Locally the native dialog is strictly better: it knows shortcuts, drives, and
      // the user's own muscle memory. Browsing exists for the case that has no dialog.
      throw new Error("local project selection uses the native folder dialog");
    }
    const profileId = profileIdOf(targetId);
    // Before the first listing, not on every level: one round trip per host per
    // session, and navigating into a directory stays a single hop.
    await ensureLauncherCurrent(profileId);
    const fs = createDesktopRemoteWorkspaceFsPort(targetId);
    let path = startingPath;
    if (!path) {
      // Order matters: an explicitly configured browse directory beats `$HOME`, because
      // a user who set one meant it. `/` is the last resort and a poor one — a wall of
      // `bin`, `boot`, `dev` with the projects nowhere in sight.
      const profiles = await desktopRemotePiProfilePort.list();
      const profile = profiles.find((candidate) => candidate.id === profileId);
      path = profile?.remoteCwd?.trim() || remoteHome(profileId) || "/";
    }
    const entries: FsEntryDto[] = await fs.listDir(path);
    return { path, entries };
  },
};
