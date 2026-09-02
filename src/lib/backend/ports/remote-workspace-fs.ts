import type { FileIndexDto, FsEntryDto, WorkspaceFsPort } from "./workspace-fs";

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
    indexFiles: async (): Promise<FileIndexDto> => refuse("indexFiles"),
    readFile: async (): Promise<string> => refuse("readFile"),
    readFileBase64: async (): Promise<string> => refuse("readFileBase64"),
    writeFile: async (): Promise<void> => refuse("writeFile"),
    createFile: async (): Promise<void> => refuse("createFile"),
    createDir: async (): Promise<void> => refuse("createDir"),
    deleteEntry: async (): Promise<void> => refuse("deleteEntry"),
    renameEntry: async (): Promise<void> => refuse("renameEntry"),
  };
}

/**
 * Hash-checked writes (V2.4), as an extension rather than a widening of
 * `WorkspaceFsPort`.
 *
 * A remote write needs optimistic concurrency because pi is editing the same tree from
 * the same host at the same time: a blind write loses whichever change landed first,
 * with nothing to say it happened. `expectedHash` is an If-Match token the *launcher*
 * minted on a previous read — never a checksum the desktop computed, so no encoding
 * subtlety here can turn a valid write into a phantom conflict.
 *
 * An extension because the local bridge has no hashes yet. The store discovers this
 * with `supportsHashedWrites` and uses it when present, so the two ports stay
 * interchangeable and the base interface keeps refusing the hashless mutators.
 */
export interface HashedReadResult {
  content: string;
  /** Opaque; pass back verbatim as `expectedHash`. */
  hash: string;
}

export interface HashedWriteResult {
  /** The token for what was just stored, so an editor can keep going without a re-read. */
  hash: string;
  bytes: number;
}

export interface HashedWorkspaceFsPort {
  readFileHashed(path: string): Promise<HashedReadResult>;
  /** `expectedHash: null` asserts the path does not exist yet. */
  writeFileHashed(
    path: string,
    content: string,
    expectedHash: string | null,
  ): Promise<HashedWriteResult>;
  createFileHashed(path: string): Promise<HashedWriteResult>;
  createDirHashed(path: string): Promise<void>;
  /** A file needs its hash; a directory must be empty and takes none. */
  deleteEntryHashed(path: string, expectedHash: string | null): Promise<void>;
  renameEntryHashed(from: string, to: string): Promise<void>;
}

/**
 * The remote host's launcher predates `--workspace` entirely.
 *
 * Distinct from `REMOTE_WORKSPACE_UNSUPPORTED`, which says *this build* has not
 * implemented an operation. This one says the host has, and the user can fix it:
 * every profile enrolled before V2 is in this state until it is reinstalled. The
 * two need different UI, so they need different types.
 */
export const REMOTE_WORKSPACE_LAUNCHER_OUTDATED = "launcher_mode_unsupported";

export class RemoteWorkspaceLauncherOutdatedError extends Error {
  readonly code = REMOTE_WORKSPACE_LAUNCHER_OUTDATED;

  constructor(
    readonly operation: string,
    readonly targetId: string,
  ) {
    super(
      `The launcher on ${targetId} is too old for remote workspace access (${operation}). Reinstall it from the remote profile settings.`,
    );
    this.name = "RemoteWorkspaceLauncherOutdatedError";
  }
}

/** The launcher's code for a lost update, with the live hash attached. */
export const REMOTE_WORKSPACE_HASH_MISMATCH = "workspaceHashMismatch";

export class RemoteWorkspaceConflictError extends Error {
  readonly code = REMOTE_WORKSPACE_HASH_MISMATCH;

  constructor(
    readonly path: string,
    /** What the file hashes to now; `null` when it no longer exists. */
    readonly currentHash: string | null,
  ) {
    super(`Remote file changed since it was read: ${path}`);
    this.name = "RemoteWorkspaceConflictError";
  }
}

/** True when a write was refused because the file changed under it. */
export function isRemoteWorkspaceConflict(
  error: unknown,
): error is RemoteWorkspaceConflictError {
  return (
    error instanceof RemoteWorkspaceConflictError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === REMOTE_WORKSPACE_HASH_MISMATCH)
  );
}

/** Whether `port` can do hash-checked writes. Absent ⇒ read-only remote workspace. */
export function supportsHashedWrites(
  port: unknown,
): port is WorkspaceFsPort & HashedWorkspaceFsPort {
  return (
    typeof port === "object" &&
    port !== null &&
    typeof (port as HashedWorkspaceFsPort).writeFileHashed === "function"
  );
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

/** True when the host's launcher is too old for the mode, and a reinstall fixes it. */
export function isRemoteWorkspaceLauncherOutdated(error: unknown): boolean {
  return (
    error instanceof RemoteWorkspaceLauncherOutdatedError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === REMOTE_WORKSPACE_LAUNCHER_OUTDATED)
  );
}
