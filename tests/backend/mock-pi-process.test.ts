import assert from "node:assert/strict";
import test from "node:test";

import { MockPiProcessPort } from "../../src/lib/backend/mock/pi-process";
import type { PiEvent } from "../../src/lib/pi/protocol";

function subscribe(process: MockPiProcessPort): PiEvent[] {
  const events: PiEvent[] = [];
  process.onLine((line) => events.push(JSON.parse(line) as PiEvent));
  return events;
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("mock event timeout"));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("browser mock preserves extension UI and failure arming behavior", async () => {
  const process = new MockPiProcessPort();
  const events = subscribe(process);
  await process.start();

  await process.send({ type: "prompt", message: "arm-extension-error", id: "prompt-1" });
  await waitFor(() => events.some((event) => event.type === "extension_ui_request"));

  await process.send({
    type: "extension_ui_response",
    id: "ui-fail",
    confirmed: true,
  });
  await waitFor(() => events.some((event) =>
    event.type === "response" &&
    event.command === "extension_ui_response" &&
    event.success === false
  ));
});

test("browser mock preserves queueing across stop and restart", async () => {
  const process = new MockPiProcessPort();
  const events = subscribe(process);
  await process.start({ cwd: "D:/first" });
  await process.stop();
  await process.start({ cwd: "D:/second", resumePath: "session-2" });

  await waitFor(() => events.some((event) =>
    event.type === "session" && event.id === "session-2" && event.cwd === "D:/second"
  ));

  await process.send({ type: "follow_up", message: "after restart" });
  await waitFor(() => events.some((event) =>
    event.type === "queue_update" && Array.isArray(event.followUp)
  ));
});
