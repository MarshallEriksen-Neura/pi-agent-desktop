import assert from "node:assert/strict";
import test from "node:test";

import {
  createAttachCursor,
  parseAttachFrame,
} from "../../src/lib/pi/remote-attach";

const handshake = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "attached",
    remoteTaskId: "task-0001",
    state: "running",
    after: null,
    baseSequence: 1,
    nextSequence: 1,
    snapshotRequired: false,
    pid: 40213,
    supervisorPid: 40199,
    ...overrides,
  });

const event = (sequence: number, data: string, stream = "stdout") =>
  JSON.stringify({ type: "event", sequence, ts: 1, stream, data });

test("an unknown or malformed frame is dropped, never thrown on", () => {
  // A launcher newer than this build may add frame types; tearing down a live
  // channel over one unrecognised line would be worse than ignoring it.
  for (const line of ["", "   ", "not json", "[]", '"text"', '{"type":"future"}']) {
    assert.equal(parseAttachFrame(line), null, line);
  }
  // Right type, wrong shape: a sequence that is not a safe non-negative integer
  // cannot be used as a cursor, so the frame is unusable.
  assert.equal(parseAttachFrame('{"type":"event","sequence":-1,"stream":"stdout"}'), null);
  assert.equal(parseAttachFrame('{"type":"event","sequence":1,"stream":"other"}'), null);
  assert.equal(parseAttachFrame('{"type":"detached","reason":"whatever"}'), null);
});

test("a failure reply is distinguished from a frame by the absence of a type", () => {
  assert.deepEqual(parseAttachFrame('{"ok":false,"errorCode":"taskNotFound"}'), {
    ok: false,
    errorCode: "taskNotFound",
  });
  assert.deepEqual(parseAttachFrame('{"ok":false,"errorCode":"taskNotRunning","detail":"exited"}'), {
    ok: false,
    errorCode: "taskNotRunning",
    detail: "exited",
  });
  assert.equal(parseAttachFrame('{"ok":false}'), null);
});

test("the cursor yields pi lines and advances only forward", () => {
  const cursor = createAttachCursor();
  assert.deepEqual(cursor.accept(handshake()).lines, []);
  assert.equal(cursor.appliedSequence, 0);

  assert.deepEqual(cursor.accept(event(1, '{"type":"ready"}')).lines, ['{"type":"ready"}']);
  assert.equal(cursor.appliedSequence, 1);

  // stderr is diagnostics only: pi's protocol errors arrive on stdout, and mixing
  // them into the chat stream would try to parse a log line as an event.
  const diagnostic = cursor.accept(event(2, "boot diagnostic", "stderr"));
  assert.deepEqual(diagnostic.lines, []);
  assert.deepEqual(diagnostic.diagnostics, ["boot diagnostic"]);
  assert.equal(cursor.appliedSequence, 2);

  // Control records carry launcher bookkeeping, not pi output.
  const control = cursor.accept(
    JSON.stringify({ type: "event", sequence: 3, ts: 1, stream: "control", event: "started" }),
  );
  assert.deepEqual(control.lines, []);
  assert.equal(cursor.appliedSequence, 3);

  // A reconnect can replay records already applied. Rewinding here would resend
  // everything after them a second time.
  assert.deepEqual(cursor.accept(event(2, "already seen")).lines, []);
  assert.equal(cursor.appliedSequence, 3);
});

test("a snapshot-required handshake tells the caller to discard its transcript", () => {
  const cursor = createAttachCursor(42);
  const step = cursor.accept(handshake({ after: 42, baseSequence: 100, snapshotRequired: true }));
  assert.equal(step.resetTranscript, true);
  // The handshake consumes no sequence space, so the cursor is untouched until real
  // records arrive — that is what makes a retry with the same stale cursor idempotent.
  assert.equal(cursor.appliedSequence, 42);
  assert.deepEqual(cursor.accept(event(100, '{"type":"resumed"}')).lines, ['{"type":"resumed"}']);
  assert.equal(cursor.appliedSequence, 100);
});

test("a mid-stream gap resets the transcript and jumps the cursor past the hole", () => {
  const cursor = createAttachCursor();
  cursor.accept(handshake());
  cursor.accept(event(1, "one"));
  const step = cursor.accept(JSON.stringify({ type: "gap", fromSequence: 2, toSequence: 899 }));
  assert.equal(step.resetTranscript, true);
  assert.deepEqual(step.lines, []);
  // Resuming from before the hole would re-request records that no longer exist.
  assert.equal(cursor.appliedSequence, 899);
  assert.deepEqual(cursor.accept(event(900, "nine-hundred")).lines, ["nine-hundred"]);
});

test("only taskExited means pi is gone", () => {
  for (const [reason, exitCode] of [
    ["taskExited", 0],
    ["caughtUp", null],
    ["taskGone", null],
  ] as const) {
    const cursor = createAttachCursor();
    cursor.accept(handshake());
    const step = cursor.accept(
      JSON.stringify({ type: "detached", reason, exitCode, nextSequence: 5 }),
    );
    assert.equal(step.detached?.reason, reason);
    assert.equal(cursor.detached?.exitCode ?? null, exitCode);
  }
});
