import type { FileIndexDto, FsEntryDto, WorkspaceFsPort } from "../ports";
import { WORKSPACE_FILES } from "../../files";

function mockList(dir: string, docs: ReadonlyMap<string, string>): FsEntryDto[] {
  const prefix = dir === "" ? "" : dir + "/";
  const dirs = new Set<string>();
  const files: FsEntryDto[] = [];
  for (const key of docs.keys()) {
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

export function createMockWorkspaceFsPort(
  files: Record<string, string> = WORKSPACE_FILES
): WorkspaceFsPort {
  const docs = new Map(Object.entries(files));

  return {
    root: async () => "",
    listDir: async (path: string) => mockList(path, docs),
    // The mock tree is a flat map of paths already, so the index is its keys plus
    // the directories they imply — the same shape the Rust walk returns, including
    // the trailing slash that marks a directory.
    indexFiles: async (): Promise<FileIndexDto> => {
      const dirs = new Set<string>();
      for (const key of docs.keys()) {
        const segments = key.split("/");
        for (let i = 1; i < segments.length; i++) {
          dirs.add(`${segments.slice(0, i).join("/")}/`);
        }
      }
      return {
        paths: [...[...dirs].sort(), ...[...docs.keys()].sort()],
        truncated: false,
      };
    },
    readFile: async (path: string) => docs.get(path) ?? "",
    readFileBase64: async (path: string) => btoa(docs.get(path) ?? ""),
    writeFile: async (path: string, content: string) => {
      docs.set(path, content);
    },
    createFile: async (path: string) => {
      if (!docs.has(path)) docs.set(path, "");
    },
    createDir: async () => undefined,
    deleteEntry: async (path: string) => {
      for (const key of [...docs.keys()]) {
        if (key === path || key.startsWith(path + "/")) docs.delete(key);
      }
    },
    renameEntry: async (from: string, to: string) => {
      const direct = docs.get(from);
      if (direct !== undefined) {
        docs.set(to, direct);
        docs.delete(from);
      }
      for (const key of [...docs.keys()]) {
        if (!key.startsWith(from + "/")) continue;
        const next = to + key.slice(from.length);
        docs.set(next, docs.get(key) ?? "");
        docs.delete(key);
      }
    },
  };
}

export const mockWorkspaceFsPort = createMockWorkspaceFsPort();
