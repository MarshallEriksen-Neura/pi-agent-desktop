import type { ProjectCatalogPort } from "../ports";
import type { RecentProject } from "../../workspace";
import { desktopInvoke } from "./invoke";

export const desktopProjectCatalogPort: ProjectCatalogPort = {
  resolve: (path: string) => desktopInvoke<string>("project_resolve", { path }),
  commit: (path: string) => desktopInvoke<string>("project_open", { path }),
  pick: () => desktopInvoke<string | null>("project_pick"),
  listRecent: () => desktopInvoke<RecentProject[]>("projects_recent"),
  removeRecent: (path: string) =>
    desktopInvoke<RecentProject[]>("project_remove_recent", { path }),
};
