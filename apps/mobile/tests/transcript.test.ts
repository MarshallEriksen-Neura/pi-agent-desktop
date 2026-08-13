import { describe, it, expect } from "vitest";
import { buildTranscript, parseToolFragment } from "@/lib/transcript";
import type { OutputFragment } from "@/stores/task-store";
import type { RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

const BASE = Date.parse("2026-08-11T10:00:00.000Z");

function frag(
  stream: OutputFragment["stream"],
  fragment: string,
  sequence: number,
  offsetMs = sequence * 1000,
): OutputFragment {
  return {
    stream,
    fragment,
    sequence,
    emittedAt: new Date(BASE + offsetMs).toISOString(),
  };
}

function interaction(
  id: string,
  offsetMs: number,
  status: RemoteInteractionSnapshot["status"] = "pending",
): RemoteInteractionSnapshot {
  const createdAt = new Date(BASE + offsetMs).toISOString();
  return {
    interactionId: id,
    taskId: "task-1",
    kind: "confirm",
    status,
    prompt: `prompt ${id}`,
    createdAt,
    expiresAt: new Date(BASE + offsetMs + 60_000).toISOString(),
  };
}

describe("parseToolFragment", () => {
  it("parses a compact gateway payload", () => {
    const tool = parseToolFragment('{"n":"edit","p":"src/a.ts","d":true,"e":true}');
    expect(tool).toEqual({
      name: "edit",
      target: "src/a.ts",
      ended: true,
      isError: true,
    });
  });

  it("defaults omitted optional fields", () => {
    // The gateway omits `p` when empty and `e` when false.
    expect(parseToolFragment('{"n":"read","d":false}')).toEqual({
      name: "read",
      target: "",
      ended: false,
      isError: false,
    });
  });

  it("returns null for truncated or malformed payloads", () => {
    // emit_output truncates by char count, so this is a real wire case.
    expect(parseToolFragment('{"n":"edit","p":"src/very-lo')).toBeNull();
    expect(parseToolFragment("not json at all")).toBeNull();
    expect(parseToolFragment("null")).toBeNull();
    expect(parseToolFragment('{"p":"no-name"}')).toBeNull();
    expect(parseToolFragment('{"n":""}')).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("merges consecutive stdout fragments into one assistant message", () => {
    // This is the core readability fix: one sentence arrives as many deltas.
    const entries = buildTranscript(null, [
      frag("stdout", "我先看一下", 1),
      frag("stdout", "登录页的实现。", 2),
    ], []);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "assistant",
      text: "我先看一下登录页的实现。",
    });
  });

  it("puts the cached prompt first as a user message", () => {
    const entries = buildTranscript("修复登录 bug", [frag("stdout", "好的", 1)], []);
    expect(entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
    expect(entries[0]).toMatchObject({ kind: "user", text: "修复登录 bug" });
  });

  it("invents no user bubble when the prompt is unknown or blank", () => {
    expect(buildTranscript(null, [], [])).toEqual([]);
    expect(buildTranscript("   ", [], [])).toEqual([]);
  });

  it("breaks the stdout run at a tool call and renders a tool entry", () => {
    const entries = buildTranscript(null, [
      frag("stdout", "先读文件。", 1),
      frag("tool", '{"n":"read","p":"src/a.ts","d":true}', 2),
      frag("stdout", "读完了。", 3),
    ], []);

    expect(entries.map((e) => e.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(entries[1]).toMatchObject({
      kind: "tool",
      tool: { name: "read", target: "src/a.ts", ended: true },
    });
  });

  it("degrades an unparseable tool payload to a system note, not a crash", () => {
    const entries = buildTranscript(null, [
      frag("tool", '{"n":"edit","p":"src/trunc', 1),
    ], []);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "system",
      text: '{"n":"edit","p":"src/trunc',
    });
  });

  it("keeps stderr out of assistant prose", () => {
    const entries = buildTranscript(null, [
      frag("stdout", "开始。", 1),
      frag("stderr", "warn: 14 files", 2),
      frag("stdout", "继续。", 3),
    ], []);

    expect(entries.map((e) => e.kind)).toEqual(["assistant", "warning", "assistant"]);
    expect(entries[0]).toMatchObject({ text: "开始。" });
    expect(entries[1]).toMatchObject({ kind: "warning", text: "warn: 14 files" });
    expect(entries[2]).toMatchObject({ text: "继续。" });
  });

  it("renders a meta fragment as a system note", () => {
    const entries = buildTranscript(null, [
      frag("meta", "[output truncated: 3 fragments dropped]", 1),
    ], []);
    expect(entries[0]).toMatchObject({
      kind: "system",
      text: "[output truncated: 3 fragments dropped]",
    });
  });

  it("inserts an interaction at its chronological position", () => {
    const entries = buildTranscript(
      null,
      [frag("stdout", "before", 1, 1000), frag("stdout", "after", 2, 3000)],
      [interaction("ix-1", 2000)],
    );

    expect(entries.map((e) => e.kind)).toEqual([
      "assistant",
      "interaction",
      "assistant",
    ]);
    expect(entries[0]).toMatchObject({ text: "before" });
    expect(entries[1]).toMatchObject({ kind: "interaction" });
    expect(entries[2]).toMatchObject({ text: "after" });
  });

  it("keeps prose emitted at the same instant above the interaction", () => {
    const entries = buildTranscript(
      null,
      [frag("stdout", "prose", 1, 2000)],
      [interaction("ix-1", 2000)],
    );
    expect(entries.map((e) => e.kind)).toEqual(["assistant", "interaction"]);
  });

  it("orders resolved and pending interactions by creation time", () => {
    const entries = buildTranscript(
      null,
      [],
      [interaction("late", 5000), interaction("early", 1000, "resolved")],
    );
    expect(entries.map((e) => e.id)).toEqual(["ix-early", "ix-late"]);
  });

  it("drops whitespace-only assistant runs", () => {
    const entries = buildTranscript(null, [
      frag("stdout", "   ", 1),
      frag("stdout", "\n\n", 2),
    ], []);
    expect(entries).toEqual([]);
  });

  it("trims trailing delta whitespace but keeps internal newlines", () => {
    const entries = buildTranscript(null, [
      frag("stdout", "第一行\n第二行", 1),
      frag("stdout", "  \n", 2),
    ], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ text: "第一行\n第二行" });
  });

  it("tolerates an invalid timestamp without reshuffling the stream", () => {
    const broken: OutputFragment = {
      stream: "stdout",
      fragment: "x",
      sequence: 1,
      emittedAt: "not-a-date",
    };
    const entries = buildTranscript(null, [broken], []);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "assistant", text: "x" });
  });

  it("returns an empty transcript for a task with no activity", () => {
    expect(buildTranscript(null, [], [])).toEqual([]);
  });
});
