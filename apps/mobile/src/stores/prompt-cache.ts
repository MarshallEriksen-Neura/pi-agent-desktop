import { create } from "zustand";

/**
 * Prompt cache — remembers the prompt text submitted for each task.
 *
 * Why this is needed: `RemoteTaskSnapshot` deliberately carries only metadata,
 * never the prompt (the gateway never ships task content back). So the phone has
 * no server-side source for the user's own message. The composer stashes it here
 * on submit and the transcript reads it back.
 *
 * Consequences of that design, handled explicitly:
 *  - The cache is per-session and in-memory. After an app restart, or when
 *    opening a task submitted from another device, `get()` returns null and the
 *    transcript renders no user bubble rather than inventing one.
 *  - Bounded to the most recent {@link MAX_CACHED_PROMPTS} tasks so a long
 *    session cannot grow it without limit.
 */

const MAX_CACHED_PROMPTS = 50;

interface PromptCacheState {
  prompts: Record<string, string>;
  /** Insertion order, oldest first — drives eviction. */
  order: string[];
  remember: (taskId: string, prompt: string) => void;
  get: (taskId: string) => string | null;
  reset: () => void;
}

export const usePromptCache = create<PromptCacheState>((set, get) => ({
  prompts: {},
  order: [],

  remember: (taskId, prompt) => {
    if (!taskId || prompt.trim().length === 0) return;
    set((s) => {
      if (s.prompts[taskId] === prompt) return s;
      const prompts = { ...s.prompts, [taskId]: prompt };
      const order = s.order.includes(taskId) ? s.order : [...s.order, taskId];
      // Evict oldest beyond the cap.
      while (order.length > MAX_CACHED_PROMPTS) {
        const evicted = order.shift();
        if (evicted !== undefined) delete prompts[evicted];
      }
      return { prompts, order };
    });
  },

  get: (taskId) => get().prompts[taskId] ?? null,

  reset: () => set({ prompts: {}, order: [] }),
}));

/** Selector for reactive reads inside components. */
export function selectPrompt(taskId: string) {
  return (s: PromptCacheState): string | null => s.prompts[taskId] ?? null;
}
