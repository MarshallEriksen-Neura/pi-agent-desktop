import type { FileIndexDto, FsEntryDto, WorkspaceFsPort } from "../ports/workspace-fs";
import type {
  HashedReadResult,
  HashedWorkspaceFsPort,
  HashedWriteResult,
} from "../ports/remote-workspace-fs";
import {
  REMOTE_WORKSPACE_HASH_MISMATCH,
  REMOTE_WORKSPACE_LAUNCHER_OUTDATED,
  RemoteWorkspaceConflictError,
  RemoteWorkspaceLauncherOutdatedError,
  RemoteWorkspaceUnsupportedError,
} from "../ports/remote-workspace-fs";
import { desktopInvoke } from "./invoke";

/**
 * The read half of a remote workspace, over the launcher's `--workspace` mode.
 *
 * Read-only on purpose: the mutating methods still throw
 * `remoteWorkspaceUnsupported`, because a remote write needs the hash check V2.4
 * owns. A port that refuses is better than an absent one — a remote path then has no
 * route to the local `fs_bridge.rs` even if a caller forgets to check the target.
 *
 * `root()` also still refuses. A remote target's root is the binding's `remoteCwd`,
 * which the store already holds; asking the filesystem for it would invent a second
 * source of truth for something the profile already decides.
 */

export interface RemoteWorkspaceDependencies {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const DEFAULT_DEPENDENCIES: RemoteWorkspaceDependencies = {
  invoke: (command, args) => desktopInvoke(command, args),
};

type WorkspaceReply =
  | { ok: true; operation: "list"; path: string; entries: FsEntryDto[]; truncated: boolean }
  | {
      ok: true;
      operation: "read";
      path: string;
      encoding: string;
      content: string;
      bytes: number;
      hash: string;
    }
  | { ok: true; operation: "write" | "create"; path: string; bytes: number; hash: string }
  | { ok: true; operation: "mkdir"; path: string; created: boolean }
  | { ok: true; operation: "delete"; path: string; kind: "file" | "dir" }
  | { ok: true; operation: "rename"; path: string; to: string }
  | { ok: false; errorCode: string; detail?: string; currentHash?: string | null };

/** Stable codes the launcher reports; surfaced verbatim so the UI can act on them. */
export class RemoteWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly detail?: string,
  ) {
    super(`Remote workspace ${code} for ${path}${detail ? ` (${detail})` : ""}`);
    this.name = "RemoteWorkspaceError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a rejected `remote_workspace_request` means "this host's launcher predates
 * the mode" rather than a transport fault.
 *
 * Anchored to the start of the message: the backend formats transport failures as
 * `<errorCode>: <message>`, and matching loosely would also catch a path or a remote
 * banner that happened to contain the code.
 */
function isLauncherOutdated(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.startsWith(`${REMOTE_WORKSPACE_LAUNCHER_OUTDATED}:`);
}

/** `ssh:<profileId>` is the only remote target shape; anything else is a bug. */
export function profileIdFromTargetId(targetId: string): string {
  const profileId = targetId.startsWith("ssh:") ? targetId.slice(4) : "";
  if (profileId.length === 0) {
    throw new RemoteWorkspaceUnsupportedError("resolve", targetId);
  }
  return profileId;
}

export function createDesktopRemoteWorkspaceFsPort(
  targetId: string,
  dependencies: RemoteWorkspaceDependencies = DEFAULT_DEPENDENCIES,
): WorkspaceFsPort & HashedWorkspaceFsPort {
  const profileId = profileIdFromTargetId(targetId);
  const refuse = (operation: string): never => {
    throw new RemoteWorkspaceUnsupportedError(operation, targetId);
  };

  interface RequestOptions {
    encoding?: "utf8" | "base64";
    to?: string;
    /** Omitted entirely vs. explicit `null` are different assertions — see the port. */
    expectedHash?: string | null;
    body?: string;
  }

  async function request(
    operation: "list" | "read" | "write" | "create" | "mkdir" | "delete" | "rename",
    path: string,
    options: RequestOptions = {},
  ): Promise<WorkspaceReply> {
    let reply: unknown;
    try {
      reply = await dependencies.invoke<unknown>("remote_workspace_request", {
        id: profileId,
        operation,
        path,
        ...(options.encoding ? { encoding: options.encoding } : {}),
        ...(options.to === undefined ? {} : { to: options.to }),
        // `in` rather than a truthiness check: `null` is a meaningful value here.
        ...("expectedHash" in options ? { expectedHash: options.expectedHash } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (cause) {
      // A transport rejection carries a `<errorCode>: <message>` string, because a
      // launcher too old to know `--workspace` fails in its shell preamble and never
      // reaches the JSON reply path. Translating it to a type here is what keeps the
      // string match in one place instead of in every caller that draws an error.
      if (isLauncherOutdated(cause)) {
        throw new RemoteWorkspaceLauncherOutdatedError(operation, targetId);
      }
      throw cause;
    }
    if (!isRecord(reply)) throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
    if (reply.ok !== true) {
      const code = typeof reply.errorCode === "string" ? reply.errorCode : "workspaceReplyInvalid";
      // A lost update gets its own type, because the caller's response differs in kind:
      // every other failure is "it did not work", this one is "someone else got there
      // first, and here is what they wrote".
      if (code === REMOTE_WORKSPACE_HASH_MISMATCH) {
        throw new RemoteWorkspaceConflictError(
          path,
          typeof reply.currentHash === "string" ? reply.currentHash : null,
        );
      }
      throw new RemoteWorkspaceError(
        code,
        path,
        typeof reply.detail === "string" ? reply.detail : undefined,
      );
    }
    return reply as unknown as WorkspaceReply;
  }

  function expectHash(reply: WorkspaceReply, path: string): HashedWriteResult {
    if (
      reply.ok !== true ||
      !("hash" in reply) ||
      typeof reply.hash !== "string" ||
      typeof reply.bytes !== "number"
    ) {
      throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
    }
    return { hash: reply.hash, bytes: reply.bytes };
  }

  return {
    root: async (): Promise<string> => refuse("root"),
    listDir: async (path: string): Promise<FsEntryDto[]> => {
      const reply = await request("list", path, {});
      if (reply.ok !== true || reply.operation !== "list" || !Array.isArray(reply.entries)) {
        throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
      }
      // `truncated` is dropped rather than surfaced: the port's contract is a list of
      // entries, and a 2000-entry directory is already past what a tree can show
      // usefully. The launcher keeps the sorted prefix, so this is deterministic.
      return reply.entries.filter(
        (entry) =>
          isRecord(entry) &&
          typeof entry.name === "string" &&
          typeof entry.path === "string" &&
          typeof entry.isDir === "boolean",
      );
    },
    // Refused rather than walked: the launcher has no recursive listing, and
    // rebuilding one from `list` calls would be one SSH round trip per directory.
    // Composer completion degrades to "no index on this target" until the launcher
    // grows a search operation of its own.
    indexFiles: async (): Promise<FileIndexDto> => refuse("indexFiles"),
    readFile: async (path: string): Promise<string> => {
      const reply = await request("read", path, { encoding: "utf8" });
      if (reply.ok !== true || reply.operation !== "read" || typeof reply.content !== "string") {
        throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
      }
      return reply.content;
    },
    readFileBase64: async (path: string): Promise<string> => {
      const reply = await request("read", path, { encoding: "base64" });
      if (reply.ok !== true || reply.operation !== "read" || typeof reply.content !== "string") {
        throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
      }
      return reply.content;
    },

    // The hashless mutators stay refused even now that writes exist. A blind remote
    // write is exactly the lost update V2.4 was added to prevent, so a caller that has
    // no hash has to go through `readFileHashed` first rather than get a silent
    // best-effort.
    writeFile: async (): Promise<void> => refuse("writeFile"),
    createFile: async (): Promise<void> => refuse("createFile"),
    createDir: async (): Promise<void> => refuse("createDir"),
    deleteEntry: async (): Promise<void> => refuse("deleteEntry"),
    renameEntry: async (): Promise<void> => refuse("renameEntry"),

    readFileHashed: async (path: string): Promise<HashedReadResult> => {
      const reply = await request("read", path, { encoding: "utf8" });
      if (
        reply.ok !== true ||
        reply.operation !== "read" ||
        typeof reply.content !== "string" ||
        typeof reply.hash !== "string"
      ) {
        throw new RemoteWorkspaceError("workspaceReplyInvalid", path);
      }
      return { content: reply.content, hash: reply.hash };
    },
    writeFileHashed: async (
      path: string,
      content: string,
      expectedHash: string | null,
    ): Promise<HashedWriteResult> =>
      expectHash(
        await request("write", path, { encoding: "utf8", expectedHash, body: content }),
        path,
      ),
    createFileHashed: async (path: string): Promise<HashedWriteResult> =>
      expectHash(await request("create", path), path),
    createDirHashed: async (path: string): Promise<void> => {
      await request("mkdir", path);
    },
    deleteEntryHashed: async (path: string, expectedHash: string | null): Promise<void> => {
      // A directory takes no hash at all, so the key is omitted rather than sent as
      // null — the launcher rejects a hash on a directory.
      await request("delete", path, expectedHash === null ? {} : { expectedHash });
    },
    renameEntryHashed: async (from: string, to: string): Promise<void> => {
      await request("rename", from, { to });
    },
  };
}
