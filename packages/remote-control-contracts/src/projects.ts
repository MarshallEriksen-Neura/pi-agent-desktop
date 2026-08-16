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
  /** `false` on gateways that never expose file bodies (design §4). */
  readonly fileBodyAvailable: boolean;
}

/**
 * Read-only text preview of one project file (`GET /api/v1/projects/:id/file`).
 * UTF-8 text only — binary files are rejected by the gateway. Oversized files
 * come back with `truncated: true` and `content` capped at the preview limit.
 */
export interface RemoteFileBody {
  readonly relativePath: RelativeProjectPath;
  readonly content: string;
  readonly sizeBytes: number;
  readonly truncated: boolean;
}

export function isRemoteTreeFile(entry: RemoteTreeEntry): boolean {
  return entry.kind === "file";
}

export function isRemoteTreeDirectory(entry: RemoteTreeEntry): boolean {
  return entry.kind === "directory";
}
