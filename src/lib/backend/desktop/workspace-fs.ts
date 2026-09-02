import type { FileIndexDto, FsEntryDto, WorkspaceFsPort } from "../ports";
import { desktopInvoke } from "./invoke";

export const desktopWorkspaceFsPort: WorkspaceFsPort = {
  root: () => desktopInvoke<string>("workspace_root"),
  listDir: (path: string) => desktopInvoke<FsEntryDto[]>("fs_list_dir", { path }),
  indexFiles: (path: string) => desktopInvoke<FileIndexDto>("fs_index_files", { path }),
  readFile: (path: string) => desktopInvoke<string>("fs_read_file", { path }),
  readFileBase64: (path: string) => desktopInvoke<string>("fs_read_file_base64", { path }),
  writeFile: (path: string, content: string) =>
    desktopInvoke<void>("fs_write_file", { path, content }),
  createFile: (path: string) => desktopInvoke<void>("fs_create_file", { path }),
  createDir: (path: string) => desktopInvoke<void>("fs_create_dir", { path }),
  deleteEntry: (path: string) => desktopInvoke<void>("fs_delete", { path }),
  renameEntry: (from: string, to: string) =>
    desktopInvoke<void>("fs_rename", { from, to }),
};
