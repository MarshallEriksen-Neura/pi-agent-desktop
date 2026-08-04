import type { RecentProject } from "../../workspace";

export interface ProjectCatalogPort {
  /** Validate and canonicalize without changing persisted desktop state. */
  resolve(path: string): Promise<string>;
  /** Persist a successfully activated project as current/recent. */
  commit(path: string): Promise<string>;
  pick(): Promise<string | null>;
  listRecent(): Promise<RecentProject[]>;
  removeRecent(path: string): Promise<RecentProject[]>;
}
