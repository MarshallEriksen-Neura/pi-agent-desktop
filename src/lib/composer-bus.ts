"use client";

/**
 * One-way channel for pushing text into the composer from outside it.
 *
 * The draft lives in `LocalAgentPanel`'s own state, so the file tree — a sibling
 * three levels away with no import between them — has no way to reach it. A module
 * bus rather than lifting the draft into a store: the insertion point is the
 * textarea's caret, which only `ComposerInput` can read, so the *event* has to
 * travel and the edit has to happen there.
 *
 * Deliberately not `useExtUi().editorText`, which looks like the same thing. That
 * field mirrors pi's `set_editor_text` request and means *replace the whole draft*;
 * borrowing it for insert-at-caret would give one extension-protocol mirror two
 * different meanings, and the next person to read either call site would have no
 * way to tell which was intended.
 */

export interface ComposerInsertion {
  /** Path relative to the workspace root, already `@`-quoted if it needs it. */
  text: string;
}

type Listener = (insertion: ComposerInsertion) => void;

const listeners = new Set<Listener>();

export const composerBus = {
  /**
   * Insert `text` at the composer's caret.
   *
   * A no-op when no composer is mounted (zen mode, or a remote conversation, which
   * has its own input) — the alternative is queueing text that lands in whatever
   * draft happens to open next, which is worse than nothing happening.
   */
  insert(text: string) {
    listeners.forEach((listener) => listener({ text }));
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
