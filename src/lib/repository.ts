"use client";

import { create } from "zustand";
import { getPort } from "./backend/composition/container";
import type { ExecutionBinding } from "./backend/ports/execution-target";
import type {
  RepositoryDiffKind,
  RepositoryMutationRequest,
  RepositoryMutationResult,
  RepositorySnapshot,
  RepositoryStatus,
} from "./backend/ports/repository";
import { usePi } from "./pi/store";
import type { DiffLine, FileDiff, Hunk } from "./pi/file-diffs";

export interface RepositoryScope {
  targetId: string;
  workspaceRoot: string;
  binding: ExecutionBinding;
}

export interface RepositorySelection {
  path: string;
  kind: RepositoryDiffKind;
}

export type RepositoryMutationIntent =
  | { operation: "stage" | "unstage"; path: string; originalPath?: string | null }
  | { operation: "commit"; message: string };

interface RepositoryStore {
  scopeKey: string | null;
  scope: RepositoryScope | null;
  result: RepositoryStatus | null;
  loading: boolean;
  error: string | null;
  selected: RepositorySelection | null;
  diff: FileDiff | null;
  diffLoading: boolean;
  diffError: string | null;
  mutating: boolean;
  mutationError: Extract<RepositoryMutationResult, { kind: "failure" }> | null;
  refresh: (scope: RepositoryScope) => Promise<void>;
  select: (selection: RepositorySelection) => Promise<void>;
  mutate: (request: RepositoryMutationIntent) => Promise<RepositoryMutationResult | null>;
  clearSelection: () => void;
  clear: () => void;
}

let statusEpoch = 0;
let diffEpoch = 0;
let mutationEpoch = 0;
function keyOf(scope: RepositoryScope): string {
  const revision = scope.binding.kind === "ssh" ? scope.binding.profileRevision : "local";
  return `${scope.targetId}\0${scope.workspaceRoot}\0${revision}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function selectionExists(snapshot: RepositorySnapshot, selection: RepositorySelection): boolean {
  return snapshot.files.some((file) => {
    if (file.path !== selection.path) return false;
    return selection.kind === "staged" ? file.staged : file.unstaged;
  });
}

/** Parse the single-file unified patch returned by the repository backend. */
export function parseRepositoryDiff(
  path: string,
  text: string,
  truncated = false,
): FileDiff {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let previousOldEnd = 0;
  let added = 0;
  let removed = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (header) {
      if (current) {
        previousOldEnd = Math.max(
          previousOldEnd,
          current.lines.reduce((max, line) => Math.max(max, line.oldLine ?? 0), current.oldStart - 1),
        );
      }
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = {
        oldStart: oldLine,
        newStart: newLine,
        gap: Math.max(0, oldLine - previousOldEnd - 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || rawLine.startsWith("\\ No newline at end of file")) continue;

    const prefix = rawLine[0];
    const body = rawLine.slice(1);
    let line: DiffLine | null = null;
    if (prefix === " ") {
      line = { kind: " ", text: body, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
    } else if (prefix === "-") {
      line = { kind: "-", text: body, oldLine };
      oldLine += 1;
      removed += 1;
    } else if (prefix === "+") {
      line = { kind: "+", text: body, newLine };
      newLine += 1;
      added += 1;
    }
    if (line) current.lines.push(line);
  }

  return { path, at: Date.now(), hunks, added, removed, truncated: truncated || undefined };
}

export const useRepository = create<RepositoryStore>((set, get) => ({
  scopeKey: null,
  scope: null,
  result: null,
  loading: false,
  error: null,
  selected: null,
  diff: null,
  diffLoading: false,
  diffError: null,
  mutating: false,
  mutationError: null,

  refresh: async (scope) => {
    const epoch = ++statusEpoch;
    const scopeKey = keyOf(scope);
    const changed = get().scopeKey !== scopeKey;
    if (changed) { diffEpoch += 1; mutationEpoch += 1; }
    set({
      scope,
      scopeKey,
      loading: true,
      error: null,
      ...(changed ? { result: null, selected: null, diff: null, diffLoading: false, diffError: null, mutating: false, mutationError: null } : {}),
    });
    try {
      const result = await getPort("repository").status({
        targetId: scope.targetId,
        workspaceRoot: scope.workspaceRoot,
        executionBinding: scope.binding,
      });
      if (epoch !== statusEpoch || get().scopeKey !== scopeKey) return;
      const previous = get().result;
      const selected = get().selected;
      const keepSelection = result.kind === "repository" && selected !== null && selectionExists(result, selected);
      const refreshDiff =
        keepSelection &&
        previous?.kind === "repository" &&
        previous.generation !== result.generation;
      if (!keepSelection || refreshDiff) diffEpoch += 1;
      set({
        result,
        loading: false,
        selected: keepSelection ? selected : null,
        diff: keepSelection && !refreshDiff ? get().diff : null,
        diffLoading: keepSelection && !refreshDiff ? get().diffLoading : false,
        diffError: null,
      });
      if (refreshDiff && selected) void get().select(selected);
    } catch (error) {
      if (epoch !== statusEpoch || get().scopeKey !== scopeKey) return;
      set({ loading: false, error: errorText(error) });
    }
  },

  select: async (selection) => {
    const { scope, result, scopeKey } = get();
    if (!scope || result?.kind !== "repository" || !scopeKey) return;
    const epoch = ++diffEpoch;
    set({ selected: selection, diff: null, diffLoading: true, diffError: null });
    try {
      const response = await getPort("repository").diff({
        targetId: scope.targetId,
        workspaceRoot: scope.workspaceRoot,
        repoRoot: result.repoRoot,
        path: selection.path,
        diffKind: selection.kind,
        executionBinding: scope.binding,
      });
      if (epoch !== diffEpoch || get().scopeKey !== scopeKey) return;
      set({
        diff: parseRepositoryDiff(selection.path, response.text, response.truncated),
        diffLoading: false,
      });
    } catch (error) {
      if (epoch !== diffEpoch || get().scopeKey !== scopeKey) return;
      set({ diffLoading: false, diffError: errorText(error) });
    }
  },

  mutate: async (intent) => {
    const { scope, result, scopeKey } = get();
    if (!scope || result?.kind !== "repository" || !scopeKey || get().mutating) return null;
    if (usePi.getState().status === "running") {
      const failure: Extract<RepositoryMutationResult, { kind: "failure" }> = {
        kind: "failure",
        operation: intent.operation,
        reason: "piBusy",
        detail: "Pi must be idle before repository writes.",
        applied: false,
      };
      set({ mutationError: failure });
      return failure;
    }
    const epoch = ++mutationEpoch;
    set({ mutating: true, mutationError: null });
    const request = {
      ...intent,
      targetId: scope.targetId,
      workspaceRoot: scope.workspaceRoot,
      repoRoot: result.repoRoot,
      generation: result.generation,
      executionBinding: scope.binding,
    } as RepositoryMutationRequest;
    try {
      // Re-check immediately before crossing the write boundary; the UI also disables
      // controls while Pi is active, but this closes the keyboard/programmatic race.
      if (usePi.getState().status === "running") {
        const failure: Extract<RepositoryMutationResult, { kind: "failure" }> = {
          kind: "failure", operation: intent.operation, reason: "piBusy",
          detail: "Pi started running before the repository write.", applied: false,
        };
        if (epoch === mutationEpoch) set({ mutating: false, mutationError: failure });
        return failure;
      }
      const mutation = await getPort("repository").mutate(request);
      if (epoch !== mutationEpoch || get().scopeKey !== scopeKey) return mutation;
      if (mutation.kind === "failure") {
        set({ mutating: false, mutationError: mutation });
        if (mutation.reason === "staleGeneration" || mutation.reason === "repositoryChanged" || mutation.applied) {
          void get().refresh(scope);
        }
        return mutation;
      }
      statusEpoch += 1;
      diffEpoch += 1;
      const selection = get().selected;
      const keepSelection = selection !== null && selectionExists(mutation.snapshot, selection);
      set({
        result: mutation.snapshot,
        loading: false,
        error: null,
        mutating: false,
        mutationError: null,
        selected: keepSelection ? selection : null,
        diff: null,
        diffLoading: false,
        diffError: null,
      });
      if (keepSelection && selection) void get().select(selection);
      return mutation;
    } catch (error) {
      const failure: Extract<RepositoryMutationResult, { kind: "failure" }> = {
        kind: "failure", operation: intent.operation, reason: "gitUnavailable",
        detail: errorText(error), applied: false,
      };
      if (epoch === mutationEpoch && get().scopeKey === scopeKey) {
        set({ mutating: false, mutationError: failure });
      }
      return failure;
    }
  },

  clearSelection: () => {
    diffEpoch += 1;
    set({ selected: null, diff: null, diffLoading: false, diffError: null });
  },

  clear: () => {
    statusEpoch += 1;
    diffEpoch += 1;
    mutationEpoch += 1;
    set({
      scopeKey: null,
      scope: null,
      result: null,
      loading: false,
      error: null,
      selected: null,
      diff: null,
      diffLoading: false,
      diffError: null,
      mutating: false,
      mutationError: null,
    });
  },
}));
