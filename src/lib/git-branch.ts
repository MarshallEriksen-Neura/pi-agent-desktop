"use client";

import { create } from "zustand";
import {
  readGitHead,
  resolveGitHead,
  type GitFileReader,
  type GitHead,
  type GitHeadLocation,
} from "./git-head";
import {
  LOCAL_WORKSPACE_TARGET,
  workspaceFsFor,
  type WorkspaceTargetId,
} from "./workspace-target";

/**
 * The branch the top bar shows next to the project name.
 *
 * Its own store rather than a field on `useWorkspace` for the same reason the
 * file index is: this is derived from the tree rather than part of it, it goes
 * stale on its own schedule (somebody checks out a branch in another window),
 * and it must be free to answer "not a git repository" without that reading as a
 * workspace load error.
 */

/**
 * How long an answer is served before a refresh trigger re-reads.
 *
 * Short on purpose. The whole value of a branch label is being right, and the
 * refresh it guards is one read of a 41-byte file.
 */
const STALE_AFTER_MS = 3_000;

/** See `ResolveGitHeadOptions.maxAncestors`. Local only — a miss costs a stat. */
const LOCAL_MAX_ANCESTORS = 6;

/** Browser preview has no filesystem; this is the branch it used to hardcode. */
const MOCK_HEAD: GitHead = { kind: "branch", name: "main" };

/** The workspace facts a lookup needs, passed in rather than imported. */
export interface GitBranchInput {
  root: string | null;
  targetId: WorkspaceTargetId;
  mock: boolean;
}

interface GitBranchStore {
  /**
   * The `(target, root)` pair `head` describes.
   *
   * Both halves: a bare path is ambiguous across hosts, and switching either one
   * makes the current answer belong to a tree nobody is looking at.
   */
  key: string | null;
  /** Null after a resolve means "not a git working tree" — the label hides. */
  head: GitHead | null;
  /**
   * The `HEAD` file that answered, so a refresh is one read instead of the search
   * that found it. Null while unresolved, and when the search came up empty.
   */
  headPath: string | null;
  resolvedAt: number;
  /** Look up `(root, target)` when the pair changed or the answer went stale. */
  ensure: (input: GitBranchInput) => void;
  /** Re-read now, regardless of staleness. For focus, and for a finished turn. */
  refresh: (input: GitBranchInput) => void;
}

const branchKey = (root: string, targetId: WorkspaceTargetId) => `${targetId} ${root}`;

/** Guards against overlapping reads for one key (focus and a turn end colliding). */
let inFlight: string | null = null;

export const useGitBranch = create<GitBranchStore>((set, get) => {
  const load = (input: GitBranchInput, force: boolean) => {
    const { root, targetId } = input;
    if (root === null) return;
    const key = branchKey(root, targetId);
    const state = get();
    const sameKey = state.key === key;
    if (!force && sameKey && Date.now() - state.resolvedAt < STALE_AFTER_MS) return;
    if (inFlight === key) return;
    inFlight = key;
    // A different project keeps nothing: the branch on screen belongs to the tree
    // being left, and showing it beside the new project's name would be a lie.
    const knownHeadPath = sameKey ? state.headPath : null;
    if (!sameKey) set({ key, head: null, headPath: null, resolvedAt: 0 });

    void (async () => {
      try {
        const located = await locate(input, root, knownHeadPath);
        // The project may have changed under the read — the same staleness guard
        // the file index uses, and for the same reason.
        if (get().key !== key || inFlight !== key) return;
        set({
          head: located?.head ?? null,
          headPath: located?.headPath ?? null,
          resolvedAt: Date.now(),
        });
      } catch {
        // Every filesystem failure is already absorbed as "no repository here", so
        // reaching this means something structural — an unconfigured backend, a
        // target with no filesystem at all. Recorded as "no branch" rather than
        // left to reject: a label nobody asked for must not raise, and without a
        // timestamp every refresh trigger would retry it on sight.
        if (get().key !== key || inFlight !== key) return;
        set({ head: null, headPath: null, resolvedAt: Date.now() });
      } finally {
        if (inFlight === key) inFlight = null;
      }
    })();
  };

  return {
    key: null,
    head: null,
    headPath: null,
    resolvedAt: 0,
    ensure: (input) => load(input, false),
    refresh: (input) => load(input, true),
  };
});

async function locate(
  input: GitBranchInput,
  root: string,
  knownHeadPath: string | null,
): Promise<GitHeadLocation | null> {
  if (input.mock) return { head: MOCK_HEAD, headPath: "" };
  const read: GitFileReader = (path) => workspaceFsFor(input.targetId).readFile(path);
  if (knownHeadPath !== null && knownHeadPath.length > 0) {
    const head = await readGitHead(read, knownHeadPath);
    if (head !== null) return { head, headPath: knownHeadPath };
    // A `HEAD` that stopped answering means the repository moved out from under
    // us — a worktree pruned, a `.git` deleted. Falling through to a full search
    // is what keeps the label from reporting the branch of a tree that is gone.
  }
  return resolveGitHead(read, root, {
    maxAncestors: input.targetId === LOCAL_WORKSPACE_TARGET ? LOCAL_MAX_ANCESTORS : 0,
  });
}
