"use client";

import { create } from "zustand";
import { isTauri } from "./pi/client";
import { usePi } from "./pi/store";
import { useSessions } from "./pi/sessions";
import { WORKSPACE_FILES } from "./files";
import { isImageFile } from "./image-files";
import { useUI } from "./store";

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

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/* ── mock tree derived from WORKSPACE_FILES keys (browser preview) ── */
function mockList(dir: string): FsEntry[] {
  const prefix = dir === "" ? "" : dir + "/";
  const dirs = new Set<string>();
  const files: FsEntry[] = [];
  for (const key of Object.keys(WORKSPACE_FILES)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, path: key, isDir: false });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  return [
    ...[...dirs].sort().map((name) => ({
      name,
      path: prefix + name,
      isDir: true,
    })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)),
  ];
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
  mock: !isTauri(),
  initialized: false,
  switching: false,
  recents: [],
  entries: {},
  expanded: {},
  docs: {},
  loadError: null,

  init: async () => {
    if (get().initialized) return;
    if (!isTauri()) {
      set({
        root: "",
        mock: true,
        initialized: true,
        entries: { "": mockList("") },
        docs: { ...WORKSPACE_FILES },
      });
      return;
    }
    try {
      const root = await tauriInvoke<string>("workspace_root");
      const top = await tauriInvoke<FsEntry[]>("fs_list_dir", { path: root });
      set({ root, mock: false, initialized: true, entries: { [root]: top } });
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
      const recents = await tauriInvoke<RecentProject[]>("projects_recent");
      set({ recents });
    } catch {
      // recents are cosmetic — never surface an error for them
    }
  },

  openProject: async (path) => {
    const { mock, switching } = get();
    if (mock || switching) return;
    set({ switching: true, loadError: null });
    try {
      // persist + canonicalize first; also refreshes recents ordering
      const root = await tauriInvoke<string>("project_open", { path });
      await get().loadRecents();
      if (root === get().root) return; // already open — reordering recents was enough

      const top = await tauriInvoke<FsEntry[]>("fs_list_dir", { path: root });
      // full reset — nothing from the previous project may leak into this one
      set({
        root,
        entries: { [root]: top },
        expanded: {},
        docs: {},
        loadError: null,
      });
      useUI.getState().setActiveFile("");
      // pi's cwd is fixed at spawn time — restart it inside the new project
      await usePi.getState().restart(root);
      // fresh project → fresh conversation (the old transcript stays in history)
      await useSessions.getState().newSession();
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ switching: false });
    }
  },

  pickProject: async () => {
    if (get().mock || get().switching) return;
    try {
      const picked = await tauriInvoke<string | null>("project_pick");
      if (picked) await get().openProject(picked);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  removeRecent: async (path) => {
    if (get().mock) return;
    try {
      const recents = await tauriInvoke<RecentProject[]>(
        "project_remove_recent",
        { path }
      );
      set({ recents });
    } catch {
      // list stays as-is on failure
    }
  },

  toggleDir: async (path) => {
    const { expanded, entries, mock } = get();
    const open = !expanded[path];
    set({ expanded: { ...expanded, [path]: open } });
    if (open && !entries[path]) {
      try {
        const children = mock
          ? mockList(path)
          : await tauriInvoke<FsEntry[]>("fs_list_dir", { path });
        set((s) => ({ entries: { ...s.entries, [path]: children } }));
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : String(e) });
      }
    }
  },

  openFile: async (path) => {
    const { docs, mock } = get();
    // images are fetched as base64 by the ImageViewer — no text doc to load
    if (docs[path] === undefined && !isImageFile(path)) {
      try {
        const content = mock
          ? (WORKSPACE_FILES[path] ?? "")
          : await tauriInvoke<string>("fs_read_file", { path });
        set((s) => ({ docs: { ...s.docs, [path]: content } }));
      } catch (e) {
        set({ loadError: e instanceof Error ? e.message : String(e) });
        return; // don't open a file we couldn't read
      }
    }
    useUI.getState().setActiveFile(path);
  },

  reloadFile: async (path) => {
    if (get().mock || isImageFile(path)) return;
    try {
      const content = await tauriInvoke<string>("fs_read_file", { path });
      set((s) => ({ docs: { ...s.docs, [path]: content } }));
    } catch {
      // binary / deleted / unreadable — keep whatever we had
    }
  },

  refreshDir: async (path) => {
    const { mock, entries } = get();
    if (mock || !entries[path]) return; // only refresh dirs already listed
    try {
      const children = await tauriInvoke<FsEntry[]>("fs_list_dir", { path });
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
      await tauriInvoke("fs_write_file", { path, content });
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  createFile: async (dirPath, name) => {
    if (get().mock) return;
    const path = `${dirPath}/${name}`;
    try {
      await tauriInvoke("fs_create_file", { path });
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
      await tauriInvoke("fs_create_dir", { path });
      await get().refreshDir(dirPath);
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) });
    }
  },

  deleteEntry: async (path, isDir) => {
    if (get().mock) return;
    try {
      await tauriInvoke("fs_delete", { path });
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
      await tauriInvoke("fs_rename", { from: oldPath, to: newPath });
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
