import { create } from "zustand";

/**
 * Tree selection — the context-file picks made in ProjectTreePage.
 *
 * Why a store instead of page state: with file previews in the tree, the user
 * leaves the page (and unmounts it) to open FileViewerPage and still expects
 * their picks to survive the round trip. The viewer can also add or remove a
 * pick, so the two pages must share one source of truth.
 *
 * Per-session and in-memory only — a restart starts clean, same as the prompt
 * cache. Selections are keyed by projectId so switching projects never leaks
 * picks across them.
 */

export type ToggleOutcome = "added" | "removed" | "capped";

interface TreeSelectionState {
  selections: Record<string, ReadonlySet<string>>;
  /** Toggle one file. `max` mirrors the server's maxContextFiles; hitting it
   *  returns "capped" so callers can surface the limit instead of silently
   *  ignoring the tap. */
  toggle: (projectId: string, path: string, max: number) => ToggleOutcome;
  clear: (projectId: string) => void;
}

export const useTreeSelectionStore = create<TreeSelectionState>((set, get) => ({
  selections: {},

  toggle: (projectId, path, max) => {
    const current = get().selections[projectId] ?? new Set<string>();
    const next = new Set(current);
    let outcome: ToggleOutcome;
    if (next.has(path)) {
      next.delete(path);
      outcome = "removed";
    } else if (next.size >= max) {
      outcome = "capped";
    } else {
      next.add(path);
      outcome = "added";
    }
    if (outcome !== "capped") {
      set((s) => ({ selections: { ...s.selections, [projectId]: next } }));
    }
    return outcome;
  },

  clear: (projectId) => {
    set((s) => {
      if (!(projectId in s.selections)) return s;
      const selections = { ...s.selections };
      delete selections[projectId];
      return { selections };
    });
  },
}));

/** Selector for reactive reads inside components (primitive result, safe to
 *  use directly in zustand's useStore selector). */
export function selectIsSelected(projectId: string, path: string) {
  return (s: TreeSelectionState): boolean => s.selections[projectId]?.has(path) ?? false;
}

/** Selector returning the pick count for a project (primitive, stable). */
export function selectCount(projectId: string) {
  return (s: TreeSelectionState): number => s.selections[projectId]?.size ?? 0;
}

/** Imperative read for navigation handlers (no reactivity needed). */
export function selectedFiles(projectId: string): string[] {
  const set = useTreeSelectionStore.getState().selections[projectId];
  return set ? Array.from(set) : [];
}
