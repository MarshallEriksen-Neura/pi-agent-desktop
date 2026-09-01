/**
 * A `prompt` must survive the local `streaming` mirror being wrong.
 *
 * pi rejects a second `prompt` while its own `isStreaming` is true unless the
 * command names a `streamingBehavior`. Our mirror is cleared by three paths pi
 * does not treat as terminal — `abort()` clearing optimistically while pi
 * unwinds a bash child, a model error pi follows with compaction, and `load()`
 * on a reattach to a mid-turn detached task — so `send`/`retryLast` can pass
 * their guard and issue a bare prompt into a live turn. That surfaced as a
 * failed turn claiming the task had stopped, when pi never stopped and the
 * message was simply dropped.
 *
 * Two properties, one cause:
 *   1. every `prompt` carries `streamingBehavior`, so a desync queues;
 *   2. inbound assistant content re-asserts `streaming`, so the mirror repairs
 *      itself even when `agent_start` arrived before we were attached.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { PiProcessExit, PiProcessPort } from "../../src/lib/backend/ports/pi-process";
import type { PiCommand } from "../../src/lib/pi/protocol";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import { resetPiStoreForTests, getPiStore } from "../../src/lib/pi/store";
import { getChatStore, clearChatStores } from "../../src/lib/pi/chat";
import { en } from "../../src/lib/i18n/en";

const TASK = "default";

/** Records commands and answers each one, so `request` never waits out its timeout. */
class ScriptedProcess implements PiProcessPort {
  readonly taskId = TASK;
  readonly sent: (PiCommand & { id?: string })[] = [];
  /** When set, every `prompt` is NACKed with this reason instead of acked. */
  nackPromptWith: string | null = null;
  private readonly lineHandlers = new Set<(line: string) => void>();

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(command: PiCommand): Promise<void> {
    const cmd = command as PiCommand & { id?: string };
    this.sent.push(cmd);
    const nack = cmd.type === "prompt" && this.nackPromptWith !== null;
    // Ack on a microtask, mirroring a real round-trip closely enough that the
    // store's `await` resolves without a timer.
    void Promise.resolve().then(() =>
      this.emit({
        type: "response",
        command: cmd.type,
        success: !nack,
        id: cmd.id,
        ...(nack ? { error: this.nackPromptWith } : {}),
      }),
    );
  }

  onLine(handler: (line: string) => void): () => void {
    this.lineHandlers.add(handler);
    return () => {
      this.lineHandlers.delete(handler);
    };
  }

  onStderr(): () => void {
    return () => undefined;
  }

  onExit(_handler: (exit: PiProcessExit) => void): () => void {
    return () => undefined;
  }

  emit(value: unknown): void {
    const line = JSON.stringify(value);
    this.lineHandlers.forEach((handler) => handler(line));
  }
}

function setup(): { process: ScriptedProcess; chat: ReturnType<typeof getChatStore> } {
  const process = new ScriptedProcess();
  configurePiClientForTests(process);
  const chat = getChatStore(TASK);
  chat.getState().init();
  // `send` refuses to dispatch unless pi looks usable, and this test is about
  // what gets dispatched.
  getPiStore(TASK).setState({ status: "ready" });
  return { process, chat };
}

function teardown(): void {
  resetPiStoreForTests();
  clearChatStores();
  resetPiClientForTests();
}

test("a prompt names its streaming behavior so a stale mirror queues instead of failing", async () => {
  const { process, chat } = setup();
  try {
    await chat.getState().send("hello");

    const prompt = process.sent.find((c) => c.type === "prompt");
    assert.ok(prompt, "a prompt was dispatched");
    assert.equal(
      (prompt as { streamingBehavior?: string }).streamingBehavior,
      "followUp",
      "pi rejects a bare prompt mid-turn; followUp keeps the user's text as its own late turn",
    );
    // The happy path is unchanged: pi ignores the field when it is idle, so this
    // is still one prompt, not a queue entry.
    assert.equal(chat.getState().messages.filter((m) => m.role === "user").length, 1);
    assert.equal(chat.getState().messages[0].delivery, undefined);
  } finally {
    teardown();
  }
});

test("retryLast also names its streaming behavior", async () => {
  const { process, chat } = setup();
  try {
    await chat.getState().send("first");
    // The turn failed, which is the only state retryLast runs from.
    chat.setState((s) => ({
      streaming: false,
      messages: [
        ...s.messages,
        {
          id: "err-1",
          role: "assistant" as const,
          text: "",
          thinking: "",
          tools: [],
          streaming: false,
          isError: true,
          errorText: "boom",
        },
      ],
    }));

    await chat.getState().retryLast();

    const prompts = process.sent.filter((c) => c.type === "prompt");
    assert.equal(prompts.length, 2, "the retry re-issued the prompt");
    assert.equal(
      (prompts[1] as { streamingBehavior?: string }).streamingBehavior,
      "followUp",
      "retry is the likeliest desync: pi runs compaction after a model error",
    );
  } finally {
    teardown();
  }
});

test("assistant content re-asserts streaming when agent_start was never seen", () => {
  const { process, chat } = setup();
  try {
    // Exactly the reattach case: the turn began before our attach cursor, so no
    // `agent_start` reaches us and `load()` left the mirror idle.
    chat.setState({ streaming: false, messages: [] });

    process.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "mid-turn token" },
    });

    assert.equal(
      chat.getState().streaming,
      true,
      "content is proof of a live turn, so the composer must lock and offer Stop",
    );
    const last = chat.getState().messages.at(-1);
    assert.equal(last?.role, "assistant");
    assert.equal(last?.text, "mid-turn token");
  } finally {
    teardown();
  }
});

test("a refused prompt does not claim the task stopped", async () => {
  const { process, chat } = setup();
  try {
    // The one cause `streamingBehavior` cannot cover: pi refuses outright while
    // compaction holds the session, and no turn starts.
    process.nackPromptWith =
      "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.";

    await chat.getState().send("hello");

    const last = chat.getState().messages.at(-1);
    assert.equal(last?.isError, true);
    // Asserted against the dictionary, not a literal: the point is which key is
    // wired up, and copy is allowed to change without breaking this.
    assert.equal(
      last?.errorText,
      en["agent.promptRefused"],
      "a NACK is a pre-turn refusal, so the notice must not describe a run that never happened",
    );
    assert.notEqual(
      last?.errorText,
      en["agent.taskFailed"],
      "the old shared key claimed the task stopped, which is what this fixes",
    );
    assert.match(last?.errorDetail ?? "", /compaction is in progress/, "pi's reason survives");
    assert.equal(chat.getState().streaming, false, "no turn is running, so the composer unlocks");
  } finally {
    teardown();
  }
});

test("agent_settled still wins over late content", () => {
  const { process, chat } = setup();
  try {
    chat.setState({ streaming: false, messages: [] });
    process.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "token" },
    });
    assert.equal(chat.getState().streaming, true);

    // pi emits this from the agent run's `finally`, i.e. strictly after all
    // content for the run — so settling must not be resurrectable.
    process.emit({ type: "agent_settled" });
    assert.equal(chat.getState().streaming, false);
    assert.deepEqual(chat.getState().queue, []);
  } finally {
    teardown();
  }
});
