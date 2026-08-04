import type { IsoTimestamp } from "./pairing";

export type ProjectId = string;
export type TreeCursor = string;
export type RelativeProjectPath = string;

export interface RemoteProjectSummary {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly lastOpenedAt?: IsoTimestamp;
}

export type RemoteTreeEntryKind = "directory" | "file";

export interface RemoteTreeEntry {
  readonly name: string;
  readonly relativePath: RelativeProjectPath;
  readonly kind: RemoteTreeEntryKind;
  readonly sizeBytes?: number;
  readonly modifiedAt?: IsoTimestamp;
}

export interface RemoteTreePage {
  readonly projectId: ProjectId;
  readonly directory: RelativeProjectPath;
  readonly entries: readonly RemoteTreeEntry[];
  readonly nextCursor?: TreeCursor;
}

export interface RemoteProjectCapabilities {
  readonly maxTreeEntriesPerPage: number;
  readonly maxContextFiles: number;
  readonly maxRelativePathBytes: number;
  readonly fileBodyAvailable: false;
}

export function isRemoteTreeFile(entry: RemoteTreeEntry): boolean {
  return entry.kind === "file";
}

export function isRemoteTreeDirectory(entry: RemoteTreeEntry): boolean {
  return entry.kind === "directory";
}
