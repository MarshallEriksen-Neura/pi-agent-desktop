/**
 * The "AI forgot the middle of the conversation" regressions.
 *
 * Two failure modes, both about the `sessionPath` pinned on a chat_sessions row:
 *
 * 1. `restart()` called with only a cwd (settings applied, CLI updated) used to
 *    respawn pi with no `--session`, so the running conversation silently lost
 *    its context and pi began writing a brand-new session file.
 * 2. The pin was written once per task and never again, so when pi did move to a
 *    different session file the row kept pointing at the old one. The next
 *    launch then resumed a stale path — and because pi's `--session <path>`
 *    creates a fresh session *at* a path whose file is missing or empty, that
 *    could also truncate a real transcript.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  configureChatRecovery,
  resetChatRecoveryForTests,
} from "../../src/lib/orchestration/chat-recovery";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../../src/lib/backend/ports/pi-process";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import { getPiStore, resetPiStoreForTests } from "../../src/lib/pi/store";
import type { PiCommand } from "../../src/lib/pi/protocol";

const TASK = "default";

/** Answers `get_state` with whatever session file it is currently told to report. */
class SessionProcess implements PiProcessPort {
  readonly taskId = TASK;
  readonly starts: PiProcessStartOptions[] = [];
  sessionFile: string;
  private line: ((line: string) => void) | null = null;

  constructor(sessionFile: string) {
    this.sessionFile = sessionFile;
  }

  async start(options?: PiProcessStartOptions): Promise<void> {
    this.starts.push(options ?? {});
  }

  async stop(): Promise<void> {}

  onLine(handler: (line: string) => void): () => void {
    this.line = handler;
    return () => {
      this.line = null;
    };
  }

  onStderr(): () => void {
    return () => undefined;
  }

  onExit(_handler: (exit: PiProcessExit) => void): () => void {
    return () => undefined;
  }

  async send(command: PiCommand): Promise<void> {
    const request = command as PiCommand & { id?: string };
    queueMicrotask(() =>
      this.line?.(
        JSON.stringify({
          type: "response",
          command: request.type,
          success: true,
          id: request.id,
          data:
            request.type === "get_state"
              ? { sessionFile: this.sessionFile, thinkingLevel: "medium" }
              : request.type === "get_available_models"
                ? { models: [] }
                : { commands: [] },
        }),
      ),
    );
  }
}

test("restart with only a cwd resumes the task's own pinned session", async () => {
  const process = new SessionProcess("live.jsonl");
  configurePiClientForTests(process);
  configureChatRecovery({
    getTarget: (taskId) => ({
      cwd: "D:/project",
      resumePath: taskId === TASK ? "pinned.jsonl" : "other-task.jsonl",
    }),
  });

  const store = getPiStore(TASK);
  await store.getState().connect({ cwd: "D:/project", resumePath: "pinned.jsonl" });
  // The settings/CLI-update call sites pass no resume path at all.
  await store.getState().restart("D:/project");

  assert.equal(process.starts.length, 2);
  assert.equal(
    process.starts[1].resumePath,
    "pinned.jsonl",
    "a bare restart must not drop --session and orphan the conversation",
  );

  resetPiStoreForTests();
  resetPiClientForTests();
  resetChatRecoveryForTests();
});

test("an explicit resume path still wins over the recovery fallback", async () => {
  const process = new SessionProcess("live.jsonl");
  configurePiClientForTests(process);
  configureChatRecovery({
    getTarget: () => ({ cwd: "D:/project", resumePath: "pinned.jsonl" }),
  });

  const store = getPiStore(TASK);
  await store.getState().restart("D:/other", "explicit.jsonl");

  assert.equal(process.starts.at(-1)?.resumePath, "explicit.jsonl");

  resetPiStoreForTests();
  resetPiClientForTests();
  resetChatRecoveryForTests();
});
