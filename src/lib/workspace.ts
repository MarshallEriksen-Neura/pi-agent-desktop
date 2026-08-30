"use client";

import { create } from "zustand";
import { isImageFile } from "./image-files";
import { useUI } from "./store";
import { getBackendKind, getPort } from "./backend/composition/container";
import { switchWorkspaceProject } from "./orchestration/project-switch";
import { useSessions } from "./pi/sessions";

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface RecentProject {
  path: string;
  name: string;
  lastOpenedAt: number;
}

interface WorkspaceStore {
  root: string | null;
  mock: boolean;
  /** true once init() has run — distinguishes "booting" from "no project" */
  initialized: boolean;
  /** a project switch is in flight (pi restarting, tree reloading) */
  switching: boolean;
  recents: RecentProject[];
  /** children per directory path ("" = root in mock mode) */
  entries: Record<string, FsEntry[]>;
  expanded: Record<string, boolean>;
  /** loaded file contents keyed by path */
  docs: Record<string, string>;
  loadError: string | null;

  init: () => Promise<void>;
  loadRecents: () => Promise<void>;
  /** Switch to the project at `path`: persist, reset state, reload tree, restart pi. */
  openProject: (path: string) => Promise<void>;
  /** Native folder picker → openProject. */
  pickProject: () => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
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

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  root: null,
  mock: false,
  initialized: false,
  switching: false,
  recents: [],
  entries: {},
  expanded: {},
  docs: {},
  loadError: null,

  init: async () => {
    if (get().initialized) return;
    try {
      const workspaceFs = getPort("workspaceFs");
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
    if (useSessions.getState().executionBinding.kind === "ssh") return;
    const { mock, switching } = get();
    if (mock || switching) return;
    set({ switching: true, loadError: null });
    try {
      await switchWorkspaceProject({
        path,
        currentRoot: get().root,
        projectCatalog: getPort("projectCatalog"),
        workspaceFs: getPort("workspaceFs"),
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
    if (useSessions.getState().executionBinding.kind === "ssh") return;
    if (get().mock || get().switching) return;
    try {
      const picked = await getPort("projectCatalog").pick();
      if (picked) await get().openProject(picked);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  removeRecent: async (path) => {
    if (get().mock) return;
    try {
      const recents = await getPort("projectCatalog").removeRecent(path);
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
        const children = await getPort("workspaceFs").listDir(path);
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
      const content = await getPort("workspaceFs").readFile(path);
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
      const content = await getPort("workspaceFs").readFile(path);
      set((s) => ({ docs: { ...s.docs, [path]: content } }));
    } catch {
      // binary / deleted / unreadable — keep whatever we had
    }
  },

  refreshDir: async (path) => {
    const { mock, entries } = get();
    if (mock || !entries[path]) return; // only refresh dirs already listed
    try {
      const children = await getPort("workspaceFs").listDir(path);
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
      await getPort("workspaceFs").writeFile(path, content);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  createFile: async (dirPath, name) => {
    if (get().mock) return;
    const path = `${dirPath}/${name}`;
    try {
      await getPort("workspaceFs").createFile(path);
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
      await getPort("workspaceFs").createDir(path);
      await get().refreshDir(dirPath);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  deleteEntry: async (path, isDir) => {
    if (get().mock) return;
    try {
      await getPort("workspaceFs").deleteEntry(path);
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
      await getPort("workspaceFs").renameEntry(oldPath, newPath);
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
