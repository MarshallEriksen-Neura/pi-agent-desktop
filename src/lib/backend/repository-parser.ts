import type {
  RepositoryFileStatus,
  RepositoryHead,
  RepositoryOperation,
  RepositorySnapshot,
} from "./ports/repository";

export interface RawRepositoryStatus {
  repoRoot: string;
  porcelain: string;
  generation: string;
  operation: RepositoryOperation;
  upstreamRemote?: string | null;
  upstreamBranch?: string | null;
  upstreamOid?: string | null;
  mergeBaseOid?: string | null;
  remotes?: string[];
  branches?: Array<{ name: string; oid: string }>;
}

function changed(status: string): boolean {
  return status !== "." && status !== " ";
}

function fileStatus(
  path: string,
  xy: string,
  options: { originalPath?: string | null; untracked?: boolean; conflicted?: boolean } = {},
): RepositoryFileStatus {
  const indexStatus = options.untracked ? "?" : (xy[0] ?? ".");
  const worktreeStatus = options.untracked ? "?" : (xy[1] ?? ".");
  return {
    path,
    originalPath: options.originalPath ?? null,
    indexStatus,
    worktreeStatus,
    staged: !options.untracked && changed(indexStatus),
    unstaged: Boolean(options.untracked) || changed(worktreeStatus),
    untracked: Boolean(options.untracked),
    conflicted: Boolean(options.conflicted),
  };
}

function parseOrdinary(record: string): RepositoryFileStatus | null {
  const match = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
  return match ? fileStatus(match[2], match[1]) : null;
}

function parseRename(record: string, originalPath: string | null): RepositoryFileStatus | null {
  const match = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
  return match ? fileStatus(match[2], match[1], { originalPath }) : null;
}

function parseConflict(record: string): RepositoryFileStatus | null {
  const match = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record);
  return match ? fileStatus(match[2], match[1], { conflicted: true }) : null;
}

export function parseRepositoryStatus(input: {
  targetId: string;
  workspaceRoot: string;
  raw: RawRepositoryStatus;
}): RepositorySnapshot {
  const records = input.raw.porcelain.split("\0");
  const files: RepositoryFileStatus[] = [];
  let oid: string | null = null;
  let branchName: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.oid ")) {
      const value = record.slice("# branch.oid ".length);
      oid = value === "(initial)" ? null : value;
      continue;
    }
    if (record.startsWith("# branch.head ")) {
      branchName = record.slice("# branch.head ".length);
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length) || null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    let file: RepositoryFileStatus | null = null;
    if (record.startsWith("1 ")) file = parseOrdinary(record);
    else if (record.startsWith("2 ")) {
      const originalPath = records[index + 1] || null;
      index += 1;
      file = parseRename(record, originalPath);
    } else if (record.startsWith("u ")) file = parseConflict(record);
    else if (record.startsWith("? ")) file = fileStatus(record.slice(2), "??", { untracked: true });
    if (file) files.push(file);
  }

  let head: RepositoryHead;
  if (oid === null) head = { kind: "unborn", name: branchName && branchName !== "(detached)" ? branchName : null };
  else if (!branchName || branchName === "(detached)") head = { kind: "detached", oid };
  else head = { kind: "branch", name: branchName, oid };

  return {
    kind: "repository",
    targetId: input.targetId,
    workspaceRoot: input.workspaceRoot,
    repoRoot: input.raw.repoRoot,
    generation: input.raw.generation,
    head,
    upstream,
    upstreamRemote: input.raw.upstreamRemote ?? null,
    upstreamBranch: input.raw.upstreamBranch ?? null,
    upstreamOid: input.raw.upstreamOid ?? null,
    mergeBaseOid: input.raw.mergeBaseOid ?? null,
    ahead,
    behind,
    remotes: input.raw.remotes ?? [],
    branches: input.raw.branches ?? [],
    operation: input.raw.operation,
    files,
  };
}
