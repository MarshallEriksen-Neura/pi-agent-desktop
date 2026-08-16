import { beforeEach, describe, expect, it } from "vitest";
import {
  useTreeSelectionStore,
  selectedFiles,
} from "@/stores/tree-selection.store";

describe("tree-selection store", () => {
  beforeEach(() => {
    useTreeSelectionStore.setState({ selections: {} });
  });

  it("toggles files within the cap and reports capped outcomes", () => {
    const store = useTreeSelectionStore.getState();
    expect(store.toggle("project-1", "a.ts", 2)).toBe("added");
    expect(store.toggle("project-1", "b.ts", 2)).toBe("added");
    expect(store.toggle("project-1", "c.ts", 2)).toBe("capped");
    // A capped toggle must not mutate state — the UI treats it as a no-op
    // apart from surfacing the limit.
    expect(selectedFiles("project-1")).toEqual(["a.ts", "b.ts"]);
    expect(store.toggle("project-1", "a.ts", 2)).toBe("removed");
    expect(store.toggle("project-1", "c.ts", 2)).toBe("added");
    expect(selectedFiles("project-1")).toEqual(["b.ts", "c.ts"]);
  });

  it("keeps selections isolated per project", () => {
    const store = useTreeSelectionStore.getState();
    store.toggle("project-1", "a.ts", 8);
    store.toggle("project-2", "z.ts", 8);
    expect(selectedFiles("project-1")).toEqual(["a.ts"]);
    expect(selectedFiles("project-2")).toEqual(["z.ts"]);
    store.clear("project-1");
    expect(selectedFiles("project-1")).toEqual([]);
    expect(selectedFiles("project-2")).toEqual(["z.ts"]);
  });

  it("subscribes components to per-file membership", () => {
    useTreeSelectionStore.getState().toggle("project-1", "a.ts", 8);
    const state = useTreeSelectionStore.getState();
    expect(state.selections["project-1"]?.has("a.ts")).toBe(true);
    expect(state.selections["project-1"]?.has("b.ts")).toBe(false);
  });
});
