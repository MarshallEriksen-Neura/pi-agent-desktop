/**
 * Tiny pub/sub bridging real agent file edits to the editor surface.
 * The agent bridge publishes "these lines of this file just changed";
 * the mounted Editor applies the streaming-diff highlight to them.
 */
export interface EditorHighlight {
  /** workspace path — same key style as useWorkspace docs (forward slashes) */
  path: string;
  /** 1-based line numbers in the NEW document */
  lines: number[];
}

type Listener = (h: EditorHighlight) => void;

const listeners = new Set<Listener>();

export const editorBus = {
  highlight(h: EditorHighlight) {
    listeners.forEach((l) => l(h));
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
