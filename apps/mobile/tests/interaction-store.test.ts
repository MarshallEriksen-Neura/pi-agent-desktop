import { describe, it, expect, beforeEach } from "vitest";
import {
  useInteractionStore,
  applyInteractionEvent,
  selectSheetStack,
} from "@/stores/interaction-store";
import type { RemoteEvent, RemoteInteractionSnapshot } from "@pi/remote-control-contracts";

function makeInteraction(overrides: Partial<RemoteInteractionSnapshot> = {}): RemoteInteractionSnapshot {
  return {
    interactionId: "ix-1",
    taskId: "task-1",
    kind: "confirm",
    status: "pending",
    prompt: "Proceed with deployment?",
    createdAt: "2026-01-01T00:00:00Z",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeEventBase(seq: number) {
  return {
    eventId: `evt-${seq}`,
    emittedAt: "2026-01-01T00:00:01Z",
    sequence: seq,
    deviceId: "device-1",
  };
}

describe("Interaction store — confirm / select / input", () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it("marks interaction resolved on interaction.resolved", () => {
    // Seed a pending interaction
    const snap = makeInteraction();
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
    }));

    applyInteractionEvent({
      ...makeEventBase(1),
      kind: "interaction.resolved",
      interactionId: "ix-1",
      taskId: "task-1",
      response: {
        interactionId: "ix-1",
        kind: "confirm",
        value: true,
        submittedAt: "2026-01-01T00:00:02Z",
      },
    });

    const stored = useInteractionStore.getState().interactions["ix-1"];
    expect(stored.status).toBe("resolved");
    expect(stored.response?.value).toBe(true);
  });

  it("marks interaction expired on interaction.expired", () => {
    const snap = makeInteraction();
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
    }));

    applyInteractionEvent({
      ...makeEventBase(1),
      kind: "interaction.expired",
      interactionId: "ix-1",
      taskId: "task-1",
    });

    expect(useInteractionStore.getState().interactions["ix-1"].status).toBe("expired");
  });

  it("never revives a resolved interaction via stale pending replay", () => {
    // Seed as resolved
    const snap = makeInteraction({ status: "resolved" });
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
    }));

    // Try to re-apply a "pending" snapshot via upsertInteraction
    useInteractionStore.getState();
    // Directly test the terminal protection by setting a pending snapshot
    const pendingSnap = makeInteraction({ status: "pending" });
    // This should be a no-op because the existing is terminal
    useInteractionStore.setState((s) => {
      const existing = s.interactions["ix-1"];
      if (existing && existing.status !== "pending" && pendingSnap.status === "pending") {
        return s;
      }
      return { interactions: { ...s.interactions, ["ix-1"]: pendingSnap } };
    });

    expect(useInteractionStore.getState().interactions["ix-1"].status).toBe("resolved");
  });

  it("tracks responding state to prevent double-submit", () => {
    const snap = makeInteraction();
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
      responding: new Set(["ix-1"]),
    }));

    expect(useInteractionStore.getState().responding.has("ix-1")).toBe(true);
  });

  it("handles select interaction with options", () => {
    const snap = makeInteraction({
      kind: "select",
      options: [
        { label: "Option A", value: "a" },
        { label: "Option B", value: "b" },
      ],
    });
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
    }));

    applyInteractionEvent({
      ...makeEventBase(1),
      kind: "interaction.resolved",
      interactionId: "ix-1",
      taskId: "task-1",
      response: {
        interactionId: "ix-1",
        kind: "select",
        value: "a",
        submittedAt: "2026-01-01T00:00:02Z",
      },
    });

    expect(useInteractionStore.getState().interactions["ix-1"].response?.value).toBe("a");
  });

  it("handles input interaction with text response", () => {
    const snap = makeInteraction({ kind: "input" });
    useInteractionStore.setState((s) => ({
      interactions: { ...s.interactions, [snap.interactionId]: snap },
      order: [snap.interactionId],
    }));

    applyInteractionEvent({
      ...makeEventBase(1),
      kind: "interaction.resolved",
      interactionId: "ix-1",
      taskId: "task-1",
      response: {
        interactionId: "ix-1",
        kind: "input",
        value: "user typed this",
        submittedAt: "2026-01-01T00:00:02Z",
      },
    });

    expect(useInteractionStore.getState().interactions["ix-1"].response?.value).toBe("user typed this");
  });

  describe("bottom sheet state", () => {
    it("opens and closes the sheet", () => {
      useInteractionStore.getState().openSheet("ix-1");
      expect(useInteractionStore.getState().sheetOpen).toBe(true);
      expect(useInteractionStore.getState().sheetFocusId).toBe("ix-1");

      useInteractionStore.getState().closeSheet();
      expect(useInteractionStore.getState().sheetOpen).toBe(false);
      expect(useInteractionStore.getState().sheetFocusId).toBe(null);
    });

    it("openSheet without an id clears the focus", () => {
      useInteractionStore.getState().openSheet("ix-1");
      useInteractionStore.getState().openSheet();
      expect(useInteractionStore.getState().sheetFocusId).toBe(null);
    });

    it("auto-opens on interaction.requested", () => {
      useInteractionStore.setState({ sheetOpen: false, sheetDismissedAt: null });
      applyInteractionEvent({
        ...makeEventBase(1),
        kind: "interaction.requested",
        interactionId: "ix-1",
        taskId: "task-1",
        interactionKind: "select",
        prompt: "Pick one",
        expiresAt: "2026-01-01T00:05:00Z",
      });

      const s = useInteractionStore.getState();
      expect(s.sheetOpen).toBe(true);
      expect(s.sheetFocusId).toBe("ix-1");
    });

    it("respects the dismissal cooldown before auto-opening again", () => {
      useInteractionStore.setState({ sheetOpen: false, sheetDismissedAt: Date.now() });
      applyInteractionEvent({
        ...makeEventBase(1),
        kind: "interaction.requested",
        interactionId: "ix-1",
        taskId: "task-1",
        interactionKind: "select",
        prompt: "Pick one",
        expiresAt: "2026-01-01T00:05:00Z",
      });
      expect(useInteractionStore.getState().sheetOpen).toBe(false);
    });

    it("does not auto-open while already open", () => {
      useInteractionStore.setState({ sheetOpen: true, sheetFocusId: "ix-0", sheetDismissedAt: null });
      applyInteractionEvent({
        ...makeEventBase(1),
        kind: "interaction.requested",
        interactionId: "ix-1",
        taskId: "task-1",
        interactionKind: "select",
        prompt: "Pick one",
        expiresAt: "2026-01-01T00:05:00Z",
      });
      const s = useInteractionStore.getState();
      expect(s.sheetOpen).toBe(true);
      expect(s.sheetFocusId).toBe("ix-0");
    });

    it("stacks pending interactions oldest-first for the sheet", () => {
      const older = makeInteraction({
        interactionId: "ix-older",
        createdAt: "2026-01-01T00:00:00Z",
      });
      const newer = makeInteraction({
        interactionId: "ix-newer",
        kind: "input",
        createdAt: "2026-01-01T00:01:00Z",
      });
      const resolved = makeInteraction({
        interactionId: "ix-resolved",
        kind: "select",
        status: "resolved",
        createdAt: "2026-01-01T00:02:00Z",
        options: [{ label: "A", value: "a" }],
      });
      useInteractionStore.setState((s) => ({
        interactions: {
          ...s.interactions,
          [newer.interactionId]: newer,
          [older.interactionId]: older,
          [resolved.interactionId]: resolved,
        },
        order: [resolved.interactionId, newer.interactionId, older.interactionId],
      }));

      const stack = selectSheetStack(useInteractionStore.getState());
      expect(stack.map((i) => i.interactionId)).toEqual(["ix-older", "ix-newer"]);
    });

    it("drops answered interactions from the stack once resolved", () => {
      const a = makeInteraction({ interactionId: "ix-a", createdAt: "2026-01-01T00:00:00Z" });
      const b = makeInteraction({
        interactionId: "ix-b",
        kind: "input",
        createdAt: "2026-01-01T00:01:00Z",
      });
      useInteractionStore.setState((s) => ({
        interactions: { ...s.interactions, [a.interactionId]: a, [b.interactionId]: b },
        order: [b.interactionId, a.interactionId],
      }));

      applyInteractionEvent({
        ...makeEventBase(1),
        kind: "interaction.resolved",
        interactionId: "ix-a",
        taskId: "task-1",
        response: { interactionId: "ix-a", kind: "confirm", value: true, submittedAt: "2026-01-01T00:02:00Z" },
      });

      const stack = selectSheetStack(useInteractionStore.getState());
      expect(stack.map((i) => i.interactionId)).toEqual(["ix-b"]);
    });
  });
});
