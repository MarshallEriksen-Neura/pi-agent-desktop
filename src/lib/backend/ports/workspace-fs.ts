export interface FsEntryDto {
  name: string;
  path: string;
  isDir: boolean;
}

export interface WorkspaceFsPort {
  root(): Promise<string>;
  listDir(path: string): Promise<FsEntryDto[]>;
  readFile(path: string): Promise<string>;
  readFileBase64(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  deleteEntry(path: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;
}
