import assert from "node:assert/strict";
import test from "node:test";
import {
  gitHeadLabel,
  parseGitdirPointer,
  parseHead,
  resolveGitHead,
  type GitFileReader,
} from "../../src/lib/git-head";

/** A fake filesystem: anything not listed rejects, exactly as the ports do. */
function reader(files: Record<string, string>): { read: GitFileReader; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    read: async (path) => {
      paths.push(path);
      const hit = files[path];
      if (hit === undefined) throw new Error(`no such file: ${path}`);
      return hit;
    },
  };
}

test("a symbolic HEAD becomes the short branch name", () => {
  assert.deepEqual(parseHead("ref: refs/heads/main\n"), { kind: "branch", name: "main" });
  // Slashes inside a branch name are part of it — only the refs/heads/ prefix goes.
  assert.deepEqual(parseHead("ref: refs/heads/feature/git-branch\n"), {
    kind: "branch",
    name: "feature/git-branch",
  });
});

test("a HEAD holding an object id is detached, and shows as a short id", () => {
  const head = parseHead("ea3ee0d7c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6\n");
  assert.deepEqual(head, { kind: "detached", sha: "ea3ee0d7c1b2a3f4e5d6c7b8a9f0e1d2c3b4a5f6" });
  assert.equal(head === null ? null : gitHeadLabel(head), "ea3ee0d");
});

test("an empty or unrecognised HEAD is no branch rather than a bad one", () => {
  // The mock workspace port answers a missing file with "", so this is the shape a
  // browser-preview read arrives in — it has to mean "nothing", not a blank label.
  assert.equal(parseHead(""), null);
  assert.equal(parseHead("\n"), null);
  assert.equal(parseHead("ref:"), null);
  assert.equal(parseHead("not a ref and not a sha"), null);
});

test("a .git file names the real git dir, absolute or relative", () => {
  assert.equal(parseGitdirPointer("gitdir: /home/u/repo/.git/worktrees/wt\n"), "/home/u/repo/.git/worktrees/wt");
  assert.equal(parseGitdirPointer("gitdir: ../.git/modules/dep\n"), "../.git/modules/dep");
  // Windows separators, as `git worktree add` writes them there.
  assert.equal(parseGitdirPointer("gitdir: D:\\repo\\.git\\worktrees\\wt"), "D:/repo/.git/worktrees/wt");
  assert.equal(parseGitdirPointer("ref: refs/heads/main"), null);
});

test("resolves the branch of the opened root", async () => {
  const { read, paths } = reader({ "/srv/app/.git/HEAD": "ref: refs/heads/main\n" });

  const found = await resolveGitHead(read, "/srv/app");

  assert.deepEqual(found, { head: { kind: "branch", name: "main" }, headPath: "/srv/app/.git/HEAD" });
  // One read when the root is the repository: nothing speculative on the happy path.
  assert.deepEqual(paths, ["/srv/app/.git/HEAD"]);
});

test("climbs to the repository above a subdirectory root, up to the given limit", async () => {
  // The monorepo case: pi is opened at apps/web, and the branch is still the
  // repository's. Without this the label would simply vanish for those projects.
  const { read } = reader({ "/srv/repo/.git/HEAD": "ref: refs/heads/release\n" });

  const found = await resolveGitHead(read, "/srv/repo/apps/web", { maxAncestors: 6 });
  assert.equal(found?.headPath, "/srv/repo/.git/HEAD");

  // maxAncestors: 0 is what a remote target passes, because each of these reads is
  // a fresh ssh process. It looks at the opened directory and stops.
  assert.equal(await resolveGitHead(read, "/srv/repo/apps/web"), null);
  assert.equal(await resolveGitHead(read, "/srv/repo/apps/web", { maxAncestors: 1 }), null);
});

test("follows a worktree pointer, since that is how a second branch gets opened", async () => {
  const { read } = reader({
    "/srv/repo/.claude/worktrees/wt/.git": "gitdir: /srv/repo/.git/worktrees/wt\n",
    "/srv/repo/.git/worktrees/wt/HEAD": "ref: refs/heads/spike\n",
    // The main worktree is on another branch; picking this one up would be wrong.
    "/srv/repo/.git/HEAD": "ref: refs/heads/main\n",
  });

  const found = await resolveGitHead(read, "/srv/repo/.claude/worktrees/wt", {
    maxAncestors: 6,
  });

  assert.deepEqual(found, {
    head: { kind: "branch", name: "spike" },
    headPath: "/srv/repo/.git/worktrees/wt/HEAD",
  });
});

test("resolves a submodule's relative gitdir against the directory holding it", async () => {
  const { read } = reader({
    "/srv/repo/dep/.git": "gitdir: ../.git/modules/dep\n",
    "/srv/repo/.git/modules/dep/HEAD": "ref: refs/heads/vendored\n",
  });

  const found = await resolveGitHead(read, "/srv/repo/dep");

  assert.equal(found?.headPath, "/srv/repo/.git/modules/dep/HEAD");
});

test("a directory outside git resolves to nothing, and stops at the drive root", async () => {
  const { read, paths } = reader({});

  assert.equal(await resolveGitHead(read, "D:/scratch/notes", { maxAncestors: 6 }), null);

  // Windows paths: it tries the two levels that exist and does not go asking about
  // `D:` itself, which is a drive rather than a directory anybody opened.
  assert.deepEqual(paths, [
    "D:/scratch/notes/.git/HEAD",
    "D:/scratch/notes/.git",
    "D:/scratch/.git/HEAD",
  ]);
});

test("an empty root is not a lookup for the filesystem's own root", async () => {
  // `workspace_root` never returns one, but the browser-preview port returns "" —
  // and `/.git/HEAD` is not a question worth asking a remote host.
  const { read, paths } = reader({});
  assert.equal(await resolveGitHead(read, "", { maxAncestors: 6 }), null);
  assert.deepEqual(paths, []);
});
