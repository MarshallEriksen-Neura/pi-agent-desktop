import { getPort } from "../backend/composition/container";
import type { ExecutionBinding } from "../backend/ports/execution-target";
import type { RemotePiProfilePort } from "../backend/ports/remote-profiles";

/**
 * Completing a detached binding before anything tries to attach to it.
 *
 * A detached binding needs a `remoteTaskId`, and getting one costs two SSH round trips —
 * so it cannot happen inside `pi_start`, which is synchronous and holds the process
 * runtime's mutex. This runs first, and by the time the process port sees the binding it
 * is complete.
 *
 * The three cases are one call (`remote_task_ensure` decides):
 * - no id ⇒ mint one and start the task
 * - id, still alive ⇒ reuse it, which is a reattach
 * - id, dead ⇒ mint a new one and report the old one as `previousTaskId`
 *
 * **One `remoteTaskId` is one remote pi process for its entire life.** That rule is what
 * makes a sequence gap unambiguous — always eviction or disconnect, never a new process —
 * so continuing after pi exits has to be a new id, never a reuse.
 */

export interface PreparedRemoteBinding {
  binding: ExecutionBinding;
  /**
   * `true` when the task this binding names is not the one it named before, so any
   * cursor the caller was holding points into a journal that no longer continues here.
   */
  taskReplaced: boolean;
  /** Oldest sequence the new task's journal still holds, when the launcher reported it. */
  baseSequence?: number;
}

export async function prepareRemoteBinding(
  binding: ExecutionBinding,
  // Injected rather than only resolved from the container, so this is testable without
  // one — and because a function this small has no business reaching for global state.
  profilesPort: RemotePiProfilePort = getPort("remoteProfiles"),
): Promise<PreparedRemoteBinding> {
  // Attached remote and local both start pi directly; there is no task to address.
  if (binding.kind !== "ssh") return { binding, taskReplaced: false };

  const profiles = await profilesPort.list();
  const profile = profiles.find((candidate) => candidate.id === binding.profileId);
  if (profile === undefined) {
    // Deleted out from under a live conversation. Left alone rather than repaired: the
    // target picker already reports this, and inventing a binding would hide it.
    return { binding, taskReplaced: false };
  }
  if (profile.lifecycle !== "detached") {
    // Defensive, and it matters: an attached binding carrying a task id is refused by
    // `validate_binding`, so a profile flipped back to attached must drop the id rather
    // than fail every start from then on.
    return {
      binding: binding.remoteTaskId ? { ...binding, remoteTaskId: null } : binding,
      taskReplaced: false,
    };
  }

  const handle = await profilesPort.ensureTask({
    profileId: binding.profileId,
    remoteTaskId: binding.remoteTaskId ?? undefined,
    remoteCwd: binding.remoteCwd,
  });
  return {
    binding: { ...binding, remoteTaskId: handle.remoteTaskId },
    taskReplaced: handle.previousTaskId !== null && handle.previousTaskId !== undefined,
    baseSequence: handle.baseSequence ?? undefined,
  };
}
