import assert from "node:assert/strict";
import test from "node:test";

import type { SessionRepositoryPort } from "../../src/lib/backend/ports";
import type { PiProcessExit, PiProcessPort } from "../../src/lib/backend/ports/pi-process";
import { readCurrentPiSessionPath } from "../../src/lib/orchestration/session-lifecycle";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import type { PiCommand, PiState } from "../../src/lib/pi/protocol";
import {
  configureSessionDependenciesForTests,
  peekLatestSessionPath,
} from "../../src/lib/pi/sessions";

class StateProcess implements PiProcessPort {
  readonly taskId = "default";
  private line: ((line: string) => void) | null = null;

  constructor(private readonly state: PiState) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  onLine(handler: (line: string) => void): () => void {
    this.line = handler;
    return () => { this.line = null; };
  }

  onStderr(_handler: (line: string) => void): () => void {
    return () => undefined;
  }

  onExit(_handler: (exit: PiProcessExit) => void): () => void {
    return () => undefined;
  }

  async send(command: PiCommand): Promise<void> {
    const request = command as PiCommand & { id?: string };
    queueMicrotask(() => this.line?.(JSON.stringify({
      type: "response",
      command: request.type,
      success: true,
      id: request.id,
      data: this.state,
    })));
  }
}

test("session resume selection prefers file, then id, then legacy path", async () => {
  for (const [state, expected] of [
    [{ sessionFile: "file.jsonl", sessionId: "id", sessionPath: "legacy" }, "file.jsonl"],
    [{ sessionId: "id", sessionPath: "legacy" }, "id"],
    [{ sessionPath: "legacy" }, "legacy"],
  ] as Array<[PiState, string]>) {
    configurePiClientForTests(new StateProcess(state));
    assert.equal((await readCurrentPiSessionPath()).path, expected);
  }
  resetPiClientForTests();
});

test("latest-session lookup canonicalizes the project scope", async () => {
  let listedProject = "";
  const repository = {
    list: async (projectRoot: string) => {
      listedProject = projectRoot;
      return [{ sessionPath: "latest.jsonl" }];
    },
  } as unknown as SessionRepositoryPort;
  configureSessionDependenciesForTests({
    repository,
    desktopFeatures: true,
    projectRoot: () => "D:/Next",
  });
  assert.equal(await peekLatestSessionPath("D:\\Next\\"), "latest.jsonl");
  assert.equal(listedProject, "D:/Next");
  configureSessionDependenciesForTests(null);
});
