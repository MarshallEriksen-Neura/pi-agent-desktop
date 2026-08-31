import type { FsEntryDto, WorkspaceFsPort } from "./workspace-fs";

/**
 * Stable code for every remote filesystem call until V2.3 implements them.
 *
 * A code rather than prose: callers need to tell "this target cannot browse
 * files" apart from "this read failed", and the UI has to be able to offer the
 * right next step without string-matching an error message.
 */
export const REMOTE_WORKSPACE_UNSUPPORTED = "remoteWorkspaceUnsupported";

export class RemoteWorkspaceUnsupportedError extends Error {
  readonly code = REMOTE_WORKSPACE_UNSUPPORTED;

  constructor(
    readonly operation: string,
    readonly targetId: string,
  ) {
    super(`Remote workspace access is not available on ${targetId} (${operation}).`);
    this.name = "RemoteWorkspaceUnsupportedError";
  }
}

/**
 * The filesystem port for an SSH target, before remote browsing exists.
 *
 * This is deliberately a *port that refuses* rather than an absent port. The
 * whole point of resolving the filesystem per execution target is that a remote
 * binding can never resolve to the local implementation: with this in place, a
 * remote path has no route to `fs_bridge.rs` even if a caller forgets to check
 * the target, so the scattered `kind === "ssh"` early-returns in the stores stop
 * being the thing that holds the invariant up.
 *
 * V2.3 replaces the read half with real launcher-backed calls. The mutating half
 * stays refused until V2.4, which owns hash-checked writes.
 */
export function createUnsupportedRemoteWorkspaceFsPort(targetId: string): WorkspaceFsPort {
  const refuse = (operation: string): never => {
    throw new RemoteWorkspaceUnsupportedError(operation, targetId);
  };
  return {
    root: async (): Promise<string> => refuse("root"),
    listDir: async (): Promise<FsEntryDto[]> => refuse("listDir"),
    readFile: async (): Promise<string> => refuse("readFile"),
    readFileBase64: async (): Promise<string> => refuse("readFileBase64"),
    writeFile: async (): Promise<void> => refuse("writeFile"),
    createFile: async (): Promise<void> => refuse("createFile"),
    createDir: async (): Promise<void> => refuse("createDir"),
    deleteEntry: async (): Promise<void> => refuse("deleteEntry"),
    renameEntry: async (): Promise<void> => refuse("renameEntry"),
  };
}

/** True when `error` is the "this target has no filesystem access" signal. */
export function isRemoteWorkspaceUnsupported(error: unknown): boolean {
  return (
    error instanceof RemoteWorkspaceUnsupportedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === REMOTE_WORKSPACE_UNSUPPORTED)
  );
}
