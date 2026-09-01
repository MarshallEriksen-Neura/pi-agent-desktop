import type { ProjectCatalogPort } from "../ports";
import type { RecentProject } from "../../workspace";
import { LOCAL_WORKSPACE_TARGET, type WorkspaceTargetId } from "../../workspace-target";

export function createMockProjectCatalogPort(): ProjectCatalogPort {
  let recents: RecentProject[] = [];

  const remember = (path: string, name: string, targetId: WorkspaceTargetId) => {
    recents = [
      { path, name, lastOpenedAt: Date.now(), targetId },
      // The pair is the identity: the same path on another host is another project.
      ...recents.filter((item) => item.path !== path || item.targetId !== targetId),
    ];
  };

  return {
    resolve: async (path: string) => path,
    commit: async (path: string) => {
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      remember(path, name, LOCAL_WORKSPACE_TARGET);
      return path;
    },
    pick: async () => null,
    listRecent: async () => recents,
    removeRecent: async (path: string, targetId: WorkspaceTargetId = LOCAL_WORKSPACE_TARGET) => {
      recents = recents.filter((item) => item.path !== path || item.targetId !== targetId);
      return recents;
    },
    commitRemote: async (path: string, targetId: WorkspaceTargetId) => {
      remember(path, path.split("/").filter(Boolean).pop() ?? path, targetId);
      return recents;
    },
    // The preview has no SSH transport, so remote browsing must fail here rather than
    // return a fabricated tree — a mock listing would make the feature look
    // implemented in preview and absent on desktop.
    browse: async (targetId: WorkspaceTargetId) => {
      throw new Error(`remote browsing is unavailable in preview (${targetId})`);
    },
  };
}

export const mockProjectCatalogPort = createMockProjectCatalogPort();
