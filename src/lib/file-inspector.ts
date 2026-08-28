"use client";

/**
 * File inspector state — which files the user pulled out of the transcript,
 * which one is showing, and whether the surface still chases the agent.
 *
 * The `follow` flag is the point of this store. Without it the agent yanks the
 * view to whatever it is writing at that instant (which is what the bridge has
 * always done), so reading line 200 of one file while a turn edits four others
 * is impossible. Following is still the default — that behaviour is right while
 * you are watching work happen — but the moment the user opens something
 * themselves it pins, counts what it skipped, and offers a way back.
 */

import { create } from "zustand";

export type InspectorView = "source" | "diff";

export interface InspectorTab {
  /** workspace path — also the tab's identity, so one file is never two tabs */
  path: string;
  /** the tool call whose diff this tab can show; absent when only text is known */
  toolCallId?: string;
  /** what surfaced it, which decides the view it opens on */
  kind: "read" | "edit";
  /**
   * When the tool call that surfaced this tab ran. A `Read` tab renders the file
   * as it is on disk *now*, which is not necessarily what the agent read — this
   * is what lets the panel say so. Absent on history-restored calls.
   */
  sinceAt?: number;
  /** last surfaced, for LRU eviction */
  at: number;
}

/**
 * Tabs kept. Six is about what fits before the strip needs its own scrollbar,
 * and an unbounded strip is what a single refactor turns into forty labels
 * nobody reads.
 */
const MAX_TABS = 6;

interface FileInspectorStore {
  open: boolean;
  tabs: InspectorTab[];
  activePath: string | null;
  view: InspectorView;
  /** the surface still jumps to whatever the agent edits */
  follow: boolean;
  /** agent edits that landed while pinned — the "back to latest" count */
  missed: number;
  /** most recent agent edit, followed or not, so "back to latest" has a target */
  latest: { path: string; toolCallId: string } | null;

  /** A transcript row was clicked: show that file and pin the surface. */
  openTab: (tab: {
    path: string;
    toolCallId?: string;
    kind: "read" | "edit";
    sinceAt?: number;
  }) => void;
  select: (path: string) => void;
  closeTab: (path: string) => void;
  close: () => void;
  setView: (view: InspectorView) => void;
  toggleFollow: () => void;
  /** An agent edit landed — chase it, or count it. */
  noteAgentEdit: (path: string, toolCallId: string) => void;
  resumeFollow: () => void;
}

/** Promote `tab` to most-recent and drop the stalest one past the cap. */
function admit(tabs: InspectorTab[], tab: InspectorTab): InspectorTab[] {
  const rest = tabs.filter((t) => t.path !== tab.path);
  const merged = [...rest, tab].sort((a, b) => a.at - b.at);
  return merged.length > MAX_TABS ? merged.slice(merged.length - MAX_TABS) : merged;
}

export const useFileInspector = create<FileInspectorStore>((set, get) => ({
  open: false,
  tabs: [],
  activePath: null,
  view: "source",
  follow: true,
  missed: 0,
  latest: null,

  openTab: ({ path, toolCallId, kind, sinceAt }) =>
    set((s) => {
      const existing = s.tabs.find((t) => t.path === path);
      const tab: InspectorTab = {
        path,
        // a row without a recorded diff must not wipe the one this tab already
        // had: reopening a file from a Read row should still be able to show the
        // edit that came before it
        toolCallId: toolCallId ?? existing?.toolCallId,
        kind,
        sinceAt,
        at: Date.now(),
      };
      return {
        open: true,
        tabs: admit(s.tabs, tab),
        activePath: path,
        // an edit row is a request to see what changed; a read row is a request
        // to see the file
        view: kind === "edit" && tab.toolCallId ? "diff" : "source",
        // clicking is taking the wheel
        follow: false,
        missed: 0,
      };
    }),

  select: (path) =>
    set((s) => ({
      activePath: path,
      tabs: s.tabs.map((t) => (t.path === path ? { ...t, at: Date.now() } : t)),
      follow: false,
      missed: 0,
    })),

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      if (tabs.length === 0) return { tabs, activePath: null, open: false, missed: 0 };
      // fall back to the most recently surfaced neighbour, not the first — the
      // strip is ordered oldest-first, so index 0 is the stalest tab there is
      const activePath =
        s.activePath === path ? tabs[tabs.length - 1].path : s.activePath;
      return { tabs, activePath };
    }),

  close: () => set({ open: false, missed: 0 }),

  setView: (view) => set({ view }),

  toggleFollow: () => {
    if (get().follow) set({ follow: false, missed: 0 });
    else get().resumeFollow();
  },

  noteAgentEdit: (path, toolCallId) =>
    set((s) => {
      const latest = { path, toolCallId };
      // Closed panel: remember the target and stay out of the way. Filling the
      // strip with files nobody asked to see is how a tab bar stops meaning
      // "what I opened".
      if (!s.open) return { latest };
      // The file already on screen. This is the edit the user is watching, so it
      // lands in the tab they are looking at rather than being counted as
      // something they missed — clicking a still-running edit row and then being
      // told "1 new change" would be the panel arguing with itself. The view is
      // left alone: if they switched to source to read around the change, that
      // choice survives the write.
      if (s.activePath === path) {
        return {
          latest,
          tabs: s.tabs.map((t) =>
            t.path === path ? { ...t, toolCallId, kind: "edit" as const, at: Date.now() } : t,
          ),
        };
      }
      if (!s.follow) return { latest, missed: s.missed + 1 };
      return {
        latest,
        tabs: admit(s.tabs, { path, toolCallId, kind: "edit", at: Date.now() }),
        activePath: path,
        view: "diff",
      };
    }),

  resumeFollow: () =>
    set((s) => {
      if (!s.latest) return { follow: true, missed: 0 };
      const { path, toolCallId } = s.latest;
      return {
        follow: true,
        missed: 0,
        open: true,
        tabs: admit(s.tabs, { path, toolCallId, kind: "edit", at: Date.now() }),
        activePath: path,
        view: "diff",
      };
    }),
}));

/**
 * Whether the agent may still move the user's view.
 *
 * Read imperatively by the agent bridge, which must not subscribe to a store to
 * decide one branch. A closed panel answers yes: that is the editor's long-
 * standing behaviour of opening the file being edited, and nothing about
 * shipping this panel should change what happens when it isn't on screen.
 */
export function isFollowingAgent(): boolean {
  const s = useFileInspector.getState();
  return !s.open || s.follow;
}

/** The tab currently showing, if the panel has one. */
export function useActiveTab(): InspectorTab | undefined {
  const activePath = useFileInspector((s) => s.activePath);
  return useFileInspector((s) =>
    activePath ? s.tabs.find((t) => t.path === activePath) : undefined,
  );
}
