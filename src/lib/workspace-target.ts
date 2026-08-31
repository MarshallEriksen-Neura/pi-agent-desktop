import type { ExecutionBinding } from "./backend/ports/execution-target";
import type { WorkspaceFsPort } from "./backend/ports/workspace-fs";
import { getPort } from "./backend/composition/container";

/**
 * Resolving a workspace filesystem, in one place.
 *
 * The store is the main caller, but two other call sites hold only a path and
 * still need the port for whatever host that path belongs to. Routing all of
 * them through here means a target maps to a filesystem in exactly one place
 * rather than three that can drift.
 */

/** Identity of the host a workspace path belongs to. */
export type WorkspaceTargetId = "local" | `ssh:${string}`;

export const LOCAL_WORKSPACE_TARGET: WorkspaceTargetId = "local";

/** The target a binding's files live on. Mirrors the pi-process target id. */
export function workspaceTargetIdFor(
  binding: ExecutionBinding | null | undefined,
): WorkspaceTargetId {
  return binding?.kind === "ssh" ? `ssh:${binding.profileId}` : LOCAL_WORKSPACE_TARGET;
}

/**
 * The filesystem port for one target id.
 *
 * The single resolution path in the app. The workspace store is the main caller,
 * but `ImageViewer` and `readAsyncStatus` also hold a path and need the port for
 * whatever host that path belongs to — routing all three through here means
 * there is one place where a target maps to a filesystem, not three that can
 * drift apart.
 *
 * An unrecognised id resolves local. That is not a silent fallback: ids are
 * produced only by `workspaceTargetIdFor`, so anything else is a programming
 * error, and for the local case the answer is right anyway. A remote id resolves
 * to a port that refuses, never to the local bridge.
 */
export function workspaceFsFor(targetId: WorkspaceTargetId): WorkspaceFsPort {
  return getPort("createWorkspaceFs")(targetId);
}
