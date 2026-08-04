import type { ProjectCatalogPort } from "../ports";
import type { RecentProject } from "../../workspace";

export function createMockProjectCatalogPort(): ProjectCatalogPort {
  let recents: RecentProject[] = [];

  return {
    resolve: async (path: string) => path,
    commit: async (path: string) => {
      const now = Date.now();
      const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
      recents = [
        { path, name, lastOpenedAt: now },
        ...recents.filter((item) => item.path !== path),
      ];
      return path;
    },
    pick: async () => null,
    listRecent: async () => recents,
    removeRecent: async (path: string) => {
      recents = recents.filter((item) => item.path !== path);
      return recents;
    },
  };
}

export const mockProjectCatalogPort = createMockProjectCatalogPort();
