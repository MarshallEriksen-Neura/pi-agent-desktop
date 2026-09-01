import type { ProjectCatalogPort } from "../ports";
import type { RecentProject } from "../../workspace";
import type { FsEntryDto } from "../ports/workspace-fs";
import { LOCAL_WORKSPACE_TARGET, type WorkspaceTargetId } from "../../workspace-target";
import { remoteHome } from "../../remote-home-cache";
import { desktopInvoke } from "./invoke";
import { desktopRemotePiProfilePort } from "./remote-profiles";
import { createDesktopRemoteWorkspaceFsPort } from "./remote-workspace-fs";

/** `ssh:<profileId>` is the only remote target shape. */
function profileIdOf(targetId: WorkspaceTargetId): string {
  const profileId = targetId.startsWith("ssh:") ? targetId.slice(4) : "";
  if (profileId.length === 0) {
    throw new Error(`not a remote execution target: ${targetId}`);
  }
  return profileId;
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
