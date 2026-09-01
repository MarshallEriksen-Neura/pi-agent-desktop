"use client";

import { create } from "zustand";
import { isImageFile } from "./image-files";
import { useUI } from "./store";
import { getBackendKind, getPort } from "./backend/composition/container";
import { switchWorkspaceProject } from "./orchestration/project-switch";
import {
  LOCAL_WORKSPACE_TARGET,
  workspaceFsFor,
  type WorkspaceTargetId,
} from "./workspace-target";
import {
  isRemoteWorkspaceConflict,
  supportsHashedWrites,
} from "./backend/ports/remote-workspace-fs";

/** One file changed under an edit. `currentHash` is what the host holds now. */
export interface DocConflict {
  currentHash: string | null;
}

const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
  /**
   * The machine this project lives on — `"local"` or `"ssh:<profileId>"`, matching the
   * pi-process target id.
   *
   * Part of the identity, not a decoration: `/srv/app` can exist on several hosts, and
   * a bare path is only unambiguous paired with the one it belongs to. Entries written
   * before remote projects existed default to `"local"`.
   */
  targetId: WorkspaceTargetId;
}

interface WorkspaceStore {
  root: string | null;
  /**
   * Which execution target `root`, `entries` and `docs` belong to.
   *
   * Everything else in this store is keyed by bare path string, which is only
   * unambiguous because every path in one snapshot comes from one host. This
   * field is what makes that true and checkable: without it, switching a
   * conversation to an SSH target left the tree showing the *local* project with
   * nothing marking it as such.
   */
  targetId: WorkspaceTargetId;
  mock: boolean;
  /** true once init() has run — distinguishes "booting" from "no project" */
  initialized: boolean;
  /** a project switch is in flight (pi restarting, tree reloading) */
  switching: boolean;
  recents: RecentProject[];
  /**
   * If-Match token per open document, minted by the launcher on read.
   *
   * Only populated on a target that supports hash-checked writes. Never computed
   * here: hashing decoded text would disagree with the file bytes for anything
   * containing invalid UTF-8, turning one file in a hundred into a conflict nobody
   * can reproduce.
   */
  docHashes: Record<string, string>;
  /** Files whose last save was refused because the host copy moved. */
  conflicts: Record<string, DocConflict>;
  /** children per directory path ("" = root in mock mode) */
  entries: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  /** loaded file contents keyed by path */
  docs: Record<string, string>;
  loadError: string | null;
  /**
   * Repoint the store at `targetId`, dropping tree and document state that
   * belonged to the previous one. Called from the session store's execution
   * target switch through a registered seam, never directly by a component.
   */
  retarget: (targetId: WorkspaceTargetId) => void;

  init: () => Promise<void>;
  loadRecents: () => Promise<void>;
  /** Switch to the project at `path`: persist, reset state, reload tree, restart pi. */
  openProject: (path: string) => Promise<void>;
  /** Open a directory on the current *remote* target. Local paths use `openProject`. */
  openRemoteProject: (path: string) => Promise<void>;
  /** Native folder picker → openProject. */
  pickProject: () => Promise<void>;
  /** `targetId` defaults to the store's current one — the pair is the identity. */
  removeRecent: (path: string, targetId?: WorkspaceTargetId) => Promise<void>;
  /** Discard local edits, take the host copy. */
  resolveConflictWithRemote: (path: string) => Promise<void>;
  /** Keep local edits, overwrite the host copy — re-checked against its current hash. */
  resolveConflictWithLocal: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  /**
   * Load a file's text into `docs` without changing what the editor shows.
   * Resolves true when the text is available (or the path is an image, which
   * carries no text doc). Read-only surfaces — the file inspector, an edit
   * snapshot taken before the agent writes — need the content but must not
   * reach over and move the user's cursor to get it.
   */
  ensureDoc: (path: string) => Promise<boolean>;
  openFile: (path: string) => Promise<void>;
  /** Force re-read from disk (e.g. after an agent tool edited the file). */
  reloadFile: (path: string) => Promise<void>;
  /** Re-list a directory that's already loaded (e.g. agent created a file). */
  refreshDir: (path: string) => Promise<void>;
  updateDoc: (path: string, content: string) => void;
  saveFile: (path: string, content: string) => Promise<void>;
  /** Create a new empty file and open it in the editor. */
  createFile: (dirPath: string, name: string) => Promise<void>;
  /** Create a new directory. */
  createDir: (dirPath: string, name: string) => Promise<void>;
  /** Delete a file or directory (recursive). */
  deleteEntry: (path: string, isDir: boolean) => Promise<void>;
  /** Rename a file or directory in place. */
  renameEntry: (oldPath: string, newName: string) => Promise<void>;
}

/**
 * This store's filesystem: the one its current contents came from.
 *
 * Every path held in `entries`/`docs` was listed or read through the port for
 * `targetId`, so reads and writes have to go back to the same one. Resolving it
 * here instead of at each call site is what makes that structural rather than
 * remembered.
 */
const fs = () => workspaceFsFor(useWorkspace.getState().targetId);

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  root: null,
  targetId: LOCAL_WORKSPACE_TARGET,
  mock: false,
  initialized: false,
  switching: false,
  recents: [],
  docHashes: {},
  conflicts: {},
  entries: {},
  expanded: {},
  docs: {},
  loadError: null,

  retarget: (targetId) => {
    if (get().targetId === targetId) return;
    // Tree and documents are keyed by bare path, so they cannot survive a host
    // change: the same path means a different file on the other side.
    set({
      targetId,
      root: null,
      entries: {},
      expanded: {},
      docs: {},
      loadError: null,
    });
    useUI.getState().setActiveFile("");
  },

  init: async () => {
    if (get().initialized) return;
    try {
      const workspaceFs = workspaceFsFor(get().targetId);
      const root = await workspaceFs.root();
      const top = await workspaceFs.listDir(root);
      set({
        root,
        mock: getBackendKind() === "browser-preview",
        initialized: true,
        entries: { [root]: top },
      });
    } catch (e) {
      set({
        initialized: true,
        loadError: e instanceof Error ? e.message : String(e),
      });
    }
    void get().loadRecents();
  },

  loadRecents: async () => {
    if (get().mock) return;
    try {
      const recents = await getPort("projectCatalog").listRecent();
      set({ recents });
    } catch {
      // recents are cosmetic — never surface an error for them
    }
  },

  openProject: async (path) => {
    // Project switching is a local-target operation: `path` came from a native
    // dialog or the recents list, both of which describe this machine. The guard
    // stays as an early exit for clarity, but it is no longer what protects the
    // filesystem — `fs()` resolves to a refusing port under a remote target.
    if (get().targetId !== LOCAL_WORKSPACE_TARGET) return;
    const { mock, switching } = get();
    if (mock || switching) return;
    set({ switching: true, loadError: null });
    try {
      await switchWorkspaceProject({
        path,
        currentRoot: get().root,
        projectCatalog: getPort("projectCatalog"),
        workspaceFs: fs(),
        setActiveFile: (activePath) => useUI.getState().setActiveFile(activePath),
        loadRecents: get().loadRecents,
        applyProjectRoot: (root, top) => {
          set({
            root,
            entries: { [root]: top },
            expanded: {},
            docs: {},
            loadError: null,
          });
        },
      });
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ switching: false });
    }
  },

  pickProject: async () => {
    // `pick()` opens a native OS dialog, which can only ever describe this
    // machine — there is no version of it that enumerates a remote host. That
    // gap is what V2.3's `browse(targetId)` exists to fill.
    if (get().targetId !== LOCAL_WORKSPACE_TARGET) return;
    if (get().mock || get().switching) return;
    try {
      const picked = await getPort("projectCatalog").pick();
      if (picked) await get().openProject(picked);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  /**
   * Open a directory on the store's current remote target.
   *
   * Not `openProject` with a flag: that path canonicalizes through the OS, moves the
   * local workspace root, and notifies the phone gateway — none of which apply to a
   * directory on another machine. What is shared is only the shape: list the root, then
   * make it the tree.
   *
   * The listing is also the existence check. A remote `stat` would be a second round
   * trip to learn what a failed `listDir` already tells us.
   */
  openRemoteProject: async (path) => {
    const targetId = get().targetId;
    if (targetId === LOCAL_WORKSPACE_TARGET) return;
    if (get().mock || get().switching) return;
    set({ switching: true, loadError: null });
    try {
      const top = await workspaceFsFor(targetId).listDir(path);
      set({
        root: path,
        entries: { [path]: top },
        expanded: {},
        docs: {},
        loadError: null,
      });
      // Whatever was open belonged to the previous project, and on a remote target it
      // may not even exist here.
      useUI.getState().setActiveFile("");
      const recents = await getPort("projectCatalog").commitRemote(path, targetId);
      set({ recents });
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ switching: false });
    }
  },

  removeRecent: async (path, targetId) => {
    if (get().mock) return;
    try {
      const recents = await getPort("projectCatalog").removeRecent(
        path,
        targetId ?? get().targetId,
      );
      set({ recents });
    } catch {
      // list stays as-is on failure
    }
  },

  toggleDir: async (path) => {
    const { expanded, entries } = get();
    const open = !expanded[path];
    set({ expanded: { ...expanded, [path]: open } });
    if (open && !entries[path]) {
      try {
        const children = await fs().listDir(path);
        set((s) => ({ entries: { ...s.entries, [path]: children } }));
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : String(e) });
      }
    }
  },

  ensureDoc: async (path) => {
    // images are fetched as base64 by the ImageViewer — no text doc to load
    if (isImageFile(path)) return true;
    if (get().docs[path] !== undefined) return true;
    try {
      const port = fs();
      // On a target that supports it, the read also yields the token a later write has
      // to present. pi edits the same tree at the same time, so a blind write would
      // lose whichever change landed first with nothing to say it happened.
      if (supportsHashedWrites(port)) {
        const { content, hash } = await port.readFileHashed(path);
        set((s) => ({
          docs: { ...s.docs, [path]: content },
          docHashes: { ...s.docHashes, [path]: hash },
        }));
        return true;
      }
      const content = await port.readFile(path);
      set((s) => ({ docs: { ...s.docs, [path]: content } }));
      return true;
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  openFile: async (path) => {
    if (!(await get().ensureDoc(path))) return; // don't open a file we couldn't read
    useUI.getState().setActiveFile(path);
  },

  reloadFile: async (path) => {
    if (get().mock || isImageFile(path)) return;
    try {
      const content = await fs().readFile(path);
      set((s) => ({ docs: { ...s.docs, [path]: content } }));
    } catch {
      // binary / deleted / unreadable — keep whatever we had
    }
  },

  refreshDir: async (path) => {
    const { mock, entries } = get();
    if (mock || !entries[path]) return; // only refresh dirs already listed
    try {
      const children = await fs().listDir(path);
      set((s) => ({ entries: { ...s.entries, [path]: children } }));
    } catch {
      // tree stays as-is on failure
    }
  },

  updateDoc: (path, content) =>
    set((s) => ({ docs: { ...s.docs, [path]: content } })),

  saveFile: async (path, content) => {
    get().updateDoc(path, content);
    if (get().mock) return; // nowhere to persist in browser preview
    try {
      const port = fs();
      if (supportsHashedWrites(port)) {
        // `null` asserts the file is new. Omitting the assertion entirely is refused by
        // the launcher, because a caller that has not decided is how a concurrent
        // create gets clobbered.
        const expected = get().docHashes[path] ?? null;
        const { hash } = await port.writeFileHashed(path, content, expected);
        set((s) => ({ docHashes: { ...s.docHashes, [path]: hash } }));
        return;
      }
      await port.writeFile(path, content);
    } catch (e) {
      // A conflict is not a failed save, it is a different outcome: the file moved
      // under us and the user has to choose. It is surfaced as its own state so the
      // editor can offer reload-or-overwrite rather than a red error string.
      if (isRemoteWorkspaceConflict(e)) {
        set((s) => ({
          conflicts: { ...s.conflicts, [path]: { currentHash: e.currentHash } },
        }));
        return;
      }
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  /** Discard local edits and take what is on the host now. */
  resolveConflictWithRemote: async (path) => {
    const port = fs();
    if (!supportsHashedWrites(port)) return;
    try {
      const { content, hash } = await port.readFileHashed(path);
      set((s) => ({
        docs: { ...s.docs, [path]: content },
        docHashes: { ...s.docHashes, [path]: hash },
        conflicts: withoutKey(s.conflicts, path),
      }));
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  /**
   * Keep local edits and overwrite the host.
   *
   * Deliberately a second write against the *current* hash rather than a "force" flag:
   * if the file changed again between the conflict and this click, the write is refused
   * again instead of overwriting a change nobody has seen.
   */
  resolveConflictWithLocal: async (path) => {
    const port = fs();
    const conflict = get().conflicts[path];
    if (!supportsHashedWrites(port) || conflict === undefined) return;
    try {
      const { hash } = await port.writeFileHashed(
        path,
        get().docs[path] ?? "",
        conflict.currentHash,
      );
      set((s) => ({
        docHashes: { ...s.docHashes, [path]: hash },
        conflicts: withoutKey(s.conflicts, path),
      }));
    } catch (e) {
      if (isRemoteWorkspaceConflict(e)) {
        set((s) => ({
          conflicts: { ...s.conflicts, [path]: { currentHash: e.currentHash } },
        }));
        return;
      }
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  createFile: async (dirPath, name) => {
    if (get().mock) return;
    const path = `${dirPath}/${name}`;
    try {
      await fs().createFile(path);
      await get().refreshDir(dirPath);
      // open the new empty file in the editor
      set((s) => ({ docs: { ...s.docs, [path]: "" } }));
      useUI.getState().setActiveFile(path);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  createDir: async (dirPath, name) => {
    if (get().mock) return;
    const path = `${dirPath}/${name}`;
    try {
      await fs().createDir(path);
      await get().refreshDir(dirPath);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  deleteEntry: async (path, isDir) => {
    if (get().mock) return;
    try {
      await fs().deleteEntry(path);
      // remove from docs cache
      set((s) => {
        const docs = { ...s.docs };
        const entries = { ...s.entries };
        const expanded = { ...s.expanded };
        if (isDir) {
          // purge all cached children under this path
          for (const key of Object.keys(docs)) {
            if (key.startsWith(path + "/") || key === path) delete docs[key];
          }
          for (const key of Object.keys(entries)) {
            if (key.startsWith(path + "/") || key === path) delete entries[key];
          }
          for (const key of Object.keys(expanded)) {
            if (key.startsWith(path + "/") || key === path) delete expanded[key];
          }
        } else {
          delete docs[path];
        }
        return { docs, entries, expanded };
      });
      // if this was the active file, deselect it
      if (useUI.getState().activeFile === path) {
        useUI.getState().setActiveFile("");
      }
      // re-list the parent so it reflects the deletion
      const parent = path.substring(0, path.lastIndexOf("/"));
      if (parent) await get().refreshDir(parent);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  renameEntry: async (oldPath, newName) => {
    if (get().mock) return;
    const parent = oldPath.substring(0, oldPath.lastIndexOf("/"));
    const newPath = `${parent}/${newName}`;
    try {
      await fs().renameEntry(oldPath, newPath);
      // migrate cached doc content to new key
      set((s) => {
        const docs = { ...s.docs };
        if (oldPath in docs) {
          docs[newPath] = docs[oldPath];
          delete docs[oldPath];
        }
        return { docs };
      });
      if (useUI.getState().activeFile === oldPath) {
        useUI.getState().setActiveFile(newPath);
      }
      if (parent) await get().refreshDir(parent);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },
}));

/** Display name of a project root — its last path segment. */
export function projectName(root: string | null): string {
  if (!root) return "";
  return root.split("/").filter(Boolean).pop() ?? root;
}
