import assert from "node:assert/strict";
import test from "node:test";
import { parseRepositoryStatus } from "../../src/lib/backend/repository-parser";

const hashes = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];

test("parses porcelain v2 branch metadata and independent index/worktree states", () => {
  const porcelain = [
    `# branch.oid ${hashes[0]}`,
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    `1 M. N... 100644 100644 100644 ${hashes[0]} ${hashes[1]} staged.ts`,
    `1 .M N... 100644 100644 100644 ${hashes[0]} ${hashes[0]} unstaged file.ts`,
    `1 MM N... 100644 100644 100644 ${hashes[0]} ${hashes[1]} both.ts`,
    "? new file.ts",
    "",
  ].join("\0");

  const status = parseRepositoryStatus({
    targetId: "local",
    workspaceRoot: "/work/subdir",
    raw: {
      repoRoot: "/work", porcelain, generation: "server-generation-1", operation: null,
      mergeBaseOid: hashes[0],
    },
  });

  assert.deepEqual(status.head, { kind: "branch", name: "main", oid: hashes[0] });
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.mergeBaseOid, hashes[0]);
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 3);
  assert.deepEqual(
    status.files.map(({ path, staged, unstaged, untracked }) => ({ path, staged, unstaged, untracked })),
    [
      { path: "staged.ts", staged: true, unstaged: false, untracked: false },
      { path: "unstaged file.ts", staged: false, unstaged: true, untracked: false },
      { path: "both.ts", staged: true, unstaged: true, untracked: false },
      { path: "new file.ts", staged: false, unstaged: true, untracked: true },
    ],
  );
});

test("parses rename origins, conflicts, detached HEAD, and operation state", () => {
  const porcelain = [
    `# branch.oid ${hashes[2]}`,
    "# branch.head (detached)",
    `2 R. N... 100644 100644 100644 ${hashes[0]} ${hashes[1]} R100 renamed.ts`,
    "old name.ts",
    `u UU N... 100644 100644 100644 100644 ${hashes[0]} ${hashes[1]} ${hashes[2]} conflict.ts`,
    "",
  ].join("\0");
  const status = parseRepositoryStatus({
    targetId: "ssh:host",
    workspaceRoot: "/srv/work",
    raw: { repoRoot: "/srv/work", porcelain, generation: "server-generation-2", operation: "rebase" },
  });

  assert.deepEqual(status.head, { kind: "detached", oid: hashes[2] });
  assert.equal(status.operation, "rebase");
  assert.equal(status.files[0].path, "renamed.ts");
  assert.equal(status.files[0].originalPath, "old name.ts");
  assert.equal(status.files[0].staged, true);
  assert.equal(status.files[1].conflicted, true);
});

test("uses the authoritative backend generation", () => {
  const base = {
    targetId: "local",
    workspaceRoot: "/work",
    raw: {
      repoRoot: "/work",
      porcelain: "# branch.oid (initial)\0# branch.head main\0",
      generation: "backend-generation-a",
      operation: null as null,
    },
  };
  const first = parseRepositoryStatus(base);
  const same = parseRepositoryStatus(base);
  const changed = parseRepositoryStatus({
    ...base,
    raw: { ...base.raw, generation: "backend-generation-b" },
  });
  assert.deepEqual(first.head, { kind: "unborn", name: "main" });
  assert.equal(first.generation, same.generation);
  assert.equal(first.generation, "backend-generation-a");
  assert.equal(changed.generation, "backend-generation-b");
});
