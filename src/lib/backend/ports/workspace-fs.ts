export interface FsEntryDto {
  name: string;
  path: string;
  isDir: boolean;
}

/**
 * Every path under a root, flat, for `@`-mention completion in the composer.
 *
 * Directories carry a trailing `/`, which is both the `ls -F` convention and
 * exactly the text a mention of a directory should insert.
 */
export interface FileIndexDto {
  paths: string[];
  /** The walk stopped at its cap — the UI says so rather than implying no match. */
  truncated: boolean;
}

export interface WorkspaceFsPort {
  root(): Promise<string>;
  listDir(path: string): Promise<FsEntryDto[]>;
  /**
   * Part of the base interface even though only the local bridge implements it, for
   * the same reason the hashless mutators are: a target that cannot index has to
   * *refuse*, so the composer can tell "this machine offers no file index" apart
   * from "the walk failed" and say the right thing. A missing method would only be
   * discoverable by a caller that remembered to look.
   */
  indexFiles(path: string): Promise<FileIndexDto>;
  readFile(path: string): Promise<string>;
  readFileBase64(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  deleteEntry(path: string): Promise<void>;
  renameEntry(from: string, to: string): Promise<void>;
}
