/**
 * Auto-reconnect on exit must stay local-only.
 *
 * Locally, `pi://exit` means pi is gone, so resuming the pinned `sessionPath`
 * is safe. Remotely it means only that the local `ssh` child ended: the launcher
 * kills the remote pi by forwarding SIGHUP, which needs sshd to notice the dead
 * peer first. Under a network partition that can lag far behind the exit
 * handler, so reconnecting there starts a *second* remote pi against the session
 * file the first one still owns.
 *
 * `pi --session <path>` on a live file is not a safe concurrent operation, so
 * this is silent transcript corruption, not a cosmetic bug.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  configureChatRecovery,
  resetChatRecoveryForTests,
} from "../../src/lib/orchestration/chat-recovery";
import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import type { PiProcessExit, PiProcessPort } from "../../src/lib/backend/ports/pi-process";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import { resetPiStoreForTests } from "../../src/lib/pi/store";
import { getChatStore, clearChatStores } from "../../src/lib/pi/chat";

const TASK = "default";

const REMOTE_BINDING: ExecutionBinding = {
  kind: "ssh",
  profileId: "exit-test",
  profileRevision: 3,
  hostAlias: "exit-host",
  remoteCwd: "/srv/exit",
  launcherProtocolVersion: 1,
};

const LOCAL_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };

/**
 * Just enough of the port to fire `pi://exit`. It answers nothing: the exit
 * handler's reconnect decision is made from the recovery target alone, so a
 * process that never speaks keeps this test free of pending RPC timers.
 */
class ExitProcess implements PiProcessPort {
  readonly taskId = TASK;
  private exit: ((exit: PiProcessExit) => void) | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(): Promise<void> {}

  onLine(): () => void {
    return () => undefined;
  }

  onStderr(): () => void {
    return () => undefined;
  }

  onExit(handler: (exit: PiProcessExit) => void): () => void {
    this.exit = handler;
    return () => {
      this.exit = null;
    };
  }

  emitExit(code: number | null): void {
    this.exit?.({ code });
  }
}

/**
 * Captures the delayed reconnect instead of waiting 3s for it. Only the
 * reconnect timer is intercepted; everything else keeps the real timer so the
 * pi client's own request bookkeeping is unaffected.
 */
function captureReconnectTimer(): { pending: (() => void)[]; restore: () => void } {
  const pending: (() => void)[] = [];
  const real = globalThis.setTimeout;
  const patched = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => {
    if (delay === 3000 && typeof handler === "function") {
      pending.push(handler as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return (real as (...args: unknown[]) => ReturnType<typeof setTimeout>)(
      handler,
      delay,
      ...rest,
    );
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.setTimeout = patched;
  return {
    pending,
    restore: () => {
      globalThis.setTimeout = real;
    },
  };
}

async function runExitScenario(binding: ExecutionBinding): Promise<{
  scheduledReconnects: number;
  errorDetail: string | undefined;
}> {
  const process = new ExitProcess();
  configurePiClientForTests(process);
  configureChatRecovery({
    getTarget: () => ({
      cwd: binding.kind === "ssh" ? binding.remoteCwd : "D:/project",
      resumePath: "pinned.jsonl",
      executionBinding: binding,
    }),
  });

  // `init()` alone, deliberately — not `connect()`. Registering the exit handler
  // is all this scenario needs, and a real connect arms the store's
  // model-catch-up retry (1s → 3s → 8s → 20s) inside a closure that
  // `resetPiStoreForTests` cannot reach: it clears the store map, so the pending
  // timer later fires `refresh()` on a client this test already disposed, and
  // those never-answered requests hold 60s timers through whatever test is
  // running by then.
  const chat = getChatStore(TASK);
  chat.getState().init();

  // The guard only runs mid-run: a non-streaming exit is a normal shutdown.
  chat.setState({ streaming: true });

  const timers = captureReconnectTimer();
  try {
    process.emitExit(1);
    // Drain the microtask queue the handler's own `set` calls schedule. The
    // captured callbacks are deliberately never invoked: whether a reconnect is
    // *scheduled* is the decision D2 changed, and actually running one here
    // would drive the shared pi client through a full restart whose pending
    // requests outlive this test and break the next one.
    await Promise.resolve();
    const last = chat.getState().messages.at(-1);
    return {
      scheduledReconnects: timers.pending.length,
      errorDetail: last?.errorDetail,
    };
  } finally {
    timers.restore();
    // `resetPiStoreForTests` is required even though this test never calls
    // `connect`: the exit handler itself reaches for `getPiStore(taskId)` to mark
    // the task disconnected, which *creates* a store bound to this fake client.
    // Leaving it in the module-level map hands the next test a store wired to a
    // disposed process, whose unanswered requests then time out at 60s each.
    resetPiStoreForTests();
    resetPiClientForTests();
    resetChatRecoveryForTests();
    clearChatStores();
  }
}

test("a remote exit does not silently start a second pi on the same session file", async () => {
  const { scheduledReconnects, errorDetail } = await runExitScenario(REMOTE_BINDING);

  assert.equal(
    scheduledReconnects,
    0,
    "no reconnect may be scheduled for an SSH binding: the remote pi may still hold pinned.jsonl",
  );
  assert.match(
    errorDetail ?? "",
    /remote process status is unknown/,
    "the failure bubble must admit that remote state is unknown rather than imply a clean stop",
  );
});

test("a local exit still schedules crash recovery", async () => {
  const { scheduledReconnects } = await runExitScenario(LOCAL_BINDING);

  assert.equal(
    scheduledReconnects,
    1,
    "the local crash-recovery path must stay intact — this is the contrast that makes the remote guard a targeted fix rather than a removal",
  );
  // That the reconnect then resumes this task's own `sessionPath` is covered by
  // session-pin.test.ts, which owns the restart/resume contract.
});
