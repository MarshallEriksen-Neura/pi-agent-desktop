import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_TASK_ID } from "../../src/lib/backend/ports/pi-process";
import type {
  PiProcessExit,
  PiProcessPort,
  PiProcessStartOptions,
} from "../../src/lib/backend/ports/pi-process";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import { getPiStore, resetPiStoreForTests } from "../../src/lib/pi/store";
import type { PiCommand, PiModel, ThinkingLevel } from "../../src/lib/pi/protocol";

const TASK = DEFAULT_TASK_ID;
const MODELS: PiModel[] = [
  { provider: "test", id: "reasoning", name: "Reasoning", reasoning: true },
  { provider: "test", id: "plain", name: "Plain", reasoning: false },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ThinkingProcess implements PiProcessPort {
  readonly taskId = TASK;
  currentModel = MODELS[0];
  thinkingLevel: ThinkingLevel = "medium";
  activeControlWrites = 0;
  maxConcurrentControlWrites = 0;
  readonly controlLog: string[] = [];
  nextLevelsDelayMs = 0;
  failNextLevels = false;
  ignoreNextModelWrite = false;
  private line: ((line: string) => void) | null = null;

  async start(_options?: PiProcessStartOptions): Promise<void> {}
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

  private levels(): ThinkingLevel[] {
    return this.currentModel.id === "plain" ? ["off"] : ["off", "low", "medium", "high"];
  }

  private respond(command: PiCommand & { id?: string }, data?: unknown): void {
    this.line?.(
      JSON.stringify({
        type: "response",
        command: command.type,
        success: true,
        id: command.id,
        data,
      })
    );
  }

  async send(raw: PiCommand): Promise<void> {
    const command = raw as PiCommand & { id?: string };
    if (command.type === "set_model" || command.type === "set_thinking_level") {
      this.activeControlWrites++;
      this.maxConcurrentControlWrites = Math.max(
        this.maxConcurrentControlWrites,
        this.activeControlWrites
      );
      this.controlLog.push(
        command.type === "set_model"
          ? `model:${command.modelId}`
          : `thinking:${command.level}`
      );

      if (command.type === "set_model") {
        await sleep(command.modelId === "reasoning" ? 20 : 1);
        if (this.ignoreNextModelWrite) {
          this.ignoreNextModelWrite = false;
        } else {
          this.currentModel = MODELS.find((model) => model.id === command.modelId)!;
          if (!this.levels().includes(this.thinkingLevel)) {
            this.thinkingLevel = this.levels().at(-1)!;
          }
        }
      } else {
        await sleep(command.level === "low" ? 20 : 1);
        const supported = this.levels();
        this.thinkingLevel = supported.includes(command.level)
          ? command.level
          : supported.at(-1)!;
      }

      this.activeControlWrites--;
      this.respond(command);
      return;
    }

    if (command.type === "get_available_thinking_levels" && (this.nextLevelsDelayMs > 0 || this.failNextLevels)) {
      const levels = this.levels();
      const delay = this.nextLevelsDelayMs;
      const fail = this.failNextLevels;
      this.nextLevelsDelayMs = 0;
      this.failNextLevels = false;
      setTimeout(() => {
        if (fail) {
          this.line?.(
            JSON.stringify({
              type: "response",
              command: command.type,
              success: false,
              id: command.id,
              error: "capability lookup failed",
            })
          );
        } else {
          this.respond(command, { levels });
        }
      }, delay);
      return;
    }

    queueMicrotask(() => {
      if (command.type === "get_available_models") {
        this.respond(command, { models: MODELS });
      } else if (command.type === "get_state") {
        this.respond(command, {
          model: this.currentModel,
          thinkingLevel: this.thinkingLevel,
        });
      } else if (command.type === "get_available_thinking_levels") {
        this.respond(command, { levels: this.levels() });
      } else if (command.type === "get_commands") {
        this.respond(command, { commands: [] });
      } else {
        this.respond(command);
      }
    });
  }
}

function installMemoryStorage(): { values: Map<string, string>; restore: () => void } {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
  return {
    values,
    restore: () => {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    },
  };
}

test("thinking controls serialize writes and adopt Pi's effective model capabilities", async () => {
  const storage = installMemoryStorage();
  const process = new ThinkingProcess();
  configurePiClientForTests(process);

  try {
    const store = getPiStore(TASK);
    await store.getState().connect();

    assert.deepEqual(store.getState().availableThinkingLevels, ["off", "low", "medium", "high"]);
    assert.equal(store.getState().thinkingLevelsModelKey, "test/reasoning");

    process.failNextLevels = true;
    await store.getState().refresh();
    assert.deepEqual(
      store.getState().availableThinkingLevels,
      ["off", "low", "medium", "high"],
      "a failed capability query preserves the last successful list"
    );
    assert.equal(store.getState().thinkingLevelsStatus, "error");
    await store.getState().refresh();

    process.ignoreNextModelWrite = true;
    await store.getState().setModel(MODELS[1]);
    assert.equal(
      store.getState().currentModel?.id,
      "reasoning",
      "a model mismatch is reconciled from Pi instead of leaving optimistic state"
    );
    assert.equal(store.getState().thinkingLevelsStatus, "ready");
    assert.deepEqual(store.getState().availableThinkingLevels, ["off", "low", "medium", "high"]);

    process.nextLevelsDelayMs = 30;
    const staleRefresh = store.getState().refresh();
    await sleep(1);
    await store.getState().setModel(MODELS[1]);
    await staleRefresh;
    assert.equal(store.getState().currentModel?.id, "plain");
    assert.deepEqual(
      store.getState().availableThinkingLevels,
      ["off"],
      "a delayed snapshot from the previous model is discarded"
    );
    assert.equal(store.getState().thinkingLevelsModelKey, "test/plain");

    const first = store.getState().setModel(MODELS[0]);
    const second = store.getState().setModel(MODELS[1]);
    await Promise.all([first, second]);

    assert.equal(process.maxConcurrentControlWrites, 1, "Pi never receives overlapping control writes");
    assert.equal(process.currentModel.id, "plain", "the latest model intent wins inside Pi");
    assert.equal(store.getState().currentModel?.id, "plain");
    assert.deepEqual(store.getState().availableThinkingLevels, ["off"]);
    assert.equal(store.getState().thinkingLevelsModelKey, "test/plain");

    await store.getState().setThinking("max");
    assert.equal(store.getState().thinkingLevel, "off", "the store adopts Pi's clamped level");
    assert.equal(storage.values.get("pi-desktop.thinkingLevel"), "off");

    await store.getState().setModel(MODELS[0]);
    const low = store.getState().setThinking("low");
    const max = store.getState().setThinking("max");
    await Promise.all([low, max]);

    assert.equal(process.maxConcurrentControlWrites, 1);
    assert.equal(process.thinkingLevel, "high", "the latest unsupported intent is clamped by Pi");
    assert.equal(store.getState().thinkingLevel, "high");
    assert.equal(storage.values.get("pi-desktop.thinkingLevel"), "high");
    assert.deepEqual(process.controlLog.slice(-2), ["thinking:low", "thinking:max"]);
  } finally {
    resetPiStoreForTests();
    resetPiClientForTests();
    storage.restore();
  }
});
