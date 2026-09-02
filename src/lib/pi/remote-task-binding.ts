import { getPort } from "../backend/composition/container";
import type { ExecutionBinding } from "../backend/ports/execution-target";
import type { RemotePiProfilePort } from "../backend/ports/remote-profiles";

/**
 * Completing a detached binding before anything tries to attach to it.
 *
 * Remote task creation is a write-ahead protocol:
 *
 * 1. Mint an id locally and persist `{ remoteTaskId, remoteTaskPending: true }`.
 * 2. Ask the launcher to idempotently start or find that exact id.
 * 3. Persist the acknowledged binding with the pending marker cleared.
 * 4. Only then may the process port attach.
 *
 * A crash or lost SSH response between steps 1 and 3 leaves enough durable state
 * to retry the same id. It can never create a second process under another id.
 */

export interface PreparedRemoteBinding {
  binding: ExecutionBinding;
  /** The binding now names a different journal, so a prior replay cursor is invalid. */
  taskReplaced: boolean;
  /** Oldest sequence the task's journal still holds, when the launcher reported it. */
  baseSequence?: number;
}

type PersistBinding = (binding: ExecutionBinding) => Promise<void>;
type MintTaskId = () => string;

function defaultMintTaskId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t-${suffix}`;
}

function withoutTaskState(binding: Extract<ExecutionBinding, { kind: "ssh" }>): ExecutionBinding {
  return { ...binding, remoteTaskId: null, remoteTaskPending: false };
}

export async function prepareRemoteBinding(
  binding: ExecutionBinding,
  persistBinding: PersistBinding,
  profilesPort: RemotePiProfilePort = getPort("remoteProfiles"),
  mintTaskId: MintTaskId = defaultMintTaskId
): Promise<PreparedRemoteBinding> {
  // Attached remote and local both start Pi directly; there is no task to address.
  if (binding.kind !== "ssh") return { binding, taskReplaced: false };
  const profileId = binding.profileId;

  const profiles = await profilesPort.list();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (profile === undefined) {
    // Deleted out from under a live conversation. Inventing a binding would hide the
    // actionable profile error and could silently redirect execution.
    return { binding, taskReplaced: false };
  }
  if (profile.lifecycle !== "detached") {
    // A profile changed back to attached must not carry detached-only state.
    if (!binding.remoteTaskId && !binding.remoteTaskPending) {
      return { binding, taskReplaced: false };
    }
    const completed = withoutTaskState(binding);
    await persistBinding(completed);
    return { binding: completed, taskReplaced: false };
  }

  let pending = binding.remoteTaskPending === true;
  let previousTaskId: string | undefined;
  let taskReplaced = pending;
  let taskId = binding.remoteTaskId?.trim() || "";

  if (!pending && taskId) {
    // Never replace an id on a transport error: the remote Pi may still be alive.
    // Only an authoritative terminal/missing status permits a new journal.
    const status = await profilesPort.taskStatus(binding.profileId, taskId);
    if (status.exists && status.state !== "exited") {
      return {
        binding: binding.remoteTaskPending ? { ...binding, remoteTaskPending: false } : binding,
        taskReplaced: false,
        baseSequence: status.baseSequence ?? undefined,
      };
    }
    previousTaskId = taskId;
    taskReplaced = true;
    taskId = "";
  }

  if (!taskId) {
    taskId = mintTaskId();
    const writeAhead: ExecutionBinding = {
      ...binding,
      remoteTaskId: taskId,
      remoteTaskPending: true,
    };
    // This await is the crash-safety boundary. No host start may happen first.
    await persistBinding(writeAhead);
    binding = writeAhead;
    pending = true;
  }

  if (!pending) {
    throw new Error("detached task start requires a durable write-ahead binding");
  }

  let handle = await profilesPort.ensureTask({
    profileId: binding.profileId,
    remoteTaskId: taskId,
    previousTaskId,
    remoteCwd: binding.remoteCwd,
  });
  if (handle.remoteTaskId !== taskId) {
    throw new Error(
      `remote launcher acknowledged unexpected task id ${handle.remoteTaskId}; expected ${taskId}`
    );
  }

  if (!handle.started && handle.state === "exited") {
    // Recovery found that the pending id did run but is already terminal. It is spent;
    // write ahead a replacement before asking the host to start anything else.
    previousTaskId = taskId;
    taskReplaced = true;
    taskId = mintTaskId();
    const replacement: ExecutionBinding = {
      ...binding,
      remoteTaskId: taskId,
      remoteTaskPending: true,
    };
    await persistBinding(replacement);
    binding = replacement;
    handle = await profilesPort.ensureTask({
      profileId: binding.profileId,
      remoteTaskId: taskId,
      previousTaskId,
      remoteCwd: binding.remoteCwd,
    });
    if (handle.remoteTaskId !== taskId) {
      throw new Error(
        `remote launcher acknowledged unexpected task id ${handle.remoteTaskId}; expected ${taskId}`
      );
    }
  }

  const completed: ExecutionBinding = {
    ...binding,
    remoteTaskId: taskId,
    remoteTaskPending: false,
  };
  await persistBinding(completed);
  return {
    binding: completed,
    taskReplaced,
    baseSequence: handle.baseSequence ?? undefined,
  };
}
