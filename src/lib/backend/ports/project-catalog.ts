import type { RecentProject } from "../../workspace";

import type { WorkspaceTargetId } from "../../workspace-target";
import type { FsEntryDto } from "./workspace-fs";

export interface ProjectCatalogPort {
  /** Validate and canonicalize without changing persisted desktop state. */
  resolve(path: string): Promise<string>;
  /** Persist a successfully activated project as current/recent. */
  commit(path: string): Promise<string>;
  pick(): Promise<string | null>;
  listRecent(): Promise<RecentProject[]>;
  removeRecent(path: string, targetId?: WorkspaceTargetId): Promise<RecentProject[]>;
  /**
   * Record a project opened on a remote host.
   *
   * Separate from `commit` because almost none of it applies: there is nothing to
   * canonicalize (the path already belongs to another machine), no local workspace
   * root to move, and no phone gateway to notify — the LAN gateway shares *this*
   * desktop's project, and a directory on an SSH host is not it.
   */
  commitRemote(path: string, targetId: WorkspaceTargetId): Promise<RecentProject[]>;
  /**
   * One level of a folder tree on `targetId`, for choosing a project directory.
   *
   * `pick()` cannot serve a remote host: it returns a path from a native OS dialog,
   * and no version of that call can enumerate a directory over SSH. So remote
   * selection is a listing the app renders itself — which is also why this returns
   * entries rather than a chosen path. `startingPath` omitted means "wherever this
   * target sensibly starts": the profile's browse directory, else the remote `$HOME`.
   */
  browse(
    targetId: WorkspaceTargetId,
    startingPath?: string,
  ): Promise<{ path: string; entries: FsEntryDto[] }>;
}
