import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || (process.platform === "win32"
  ? spawnSync("where", ["sh"], { encoding: "utf8" }).stdout.trim().split("\n")[0]
  : "sh");
const posix = process.platform !== "win32";
const scratchRoot = posix ? tmpdir() : resolve(".tmp");
const toLauncherPath = (value) =>
  posix ? value : value.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");
const toMsysPath = (value) => {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
  return match ? `/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}` : value;
};

function launcherEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (posix) return env;
  const bin = join(home, "test-bin");
  mkdirSync(bin, { recursive: true });
  const wrapper = join(bin, "node");
  const nativeNode = toMsysPath(process.execPath).replaceAll("'", "'\\''");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'script="$HOME/.launcher-node.cjs"',
    'cat <&3 > "$script"',
    `exec '${nativeNode}' "$script"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  env.PATH = `${bin};${process.env.PATH ?? ""}`;
  return env;
}

function repository(home, request, envExtra = {}) {
  const encoded = Buffer.from(JSON.stringify({ protocolVersion: 1, ...request })).toString("base64");
  const result = spawnSync(shell, [launcher, "--repository", encoded], {
    encoding: "utf8",
    env: { ...launcherEnv(home), ...envExtra },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one reply line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function generationOf(status) {
  assert.equal(typeof status.generation, "string", JSON.stringify(status));
  return status.generation;
}

function withScratch(callback) {
  mkdirSync(scratchRoot, { recursive: true });
  const base = mkdtempSync(join(scratchRoot, "pi-repository-"));
  const home = join(base, "home");
  const tree = join(base, "tree");
  mkdirSync(home, { recursive: true });
  mkdirSync(tree, { recursive: true });
  try {
    return callback({ home, tree, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

function initRepository(tree) {
  git(tree, "init", "-q");
  git(tree, "config", "user.email", "repository-test@example.com");
  git(tree, "config", "user.name", "Repository Test");
  writeFileSync(join(tree, "file.txt"), "one\ntwo\n");
  git(tree, "add", "file.txt");
  git(tree, "commit", "-qm", "initial");
}

test("repository status and both Git baselines are available through the launcher", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "one\ntwo staged\n");
    git(tree, "add", "file.txt");
    writeFileSync(join(tree, "file.txt"), "one\ntwo staged\nthree unstaged\n");
    writeFileSync(join(tree, "new.txt"), "untracked\n");

    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.repoRoot.replaceAll("\\", "/").toLowerCase(), tree.replaceAll("\\", "/").toLowerCase());
    assert.match(status.porcelain, /1 MM /);
    assert.match(status.porcelain, /\? new\.txt/);

    const staged = repository(home, {
      operation: "diff",
      workspaceRoot,
      repoRoot: status.repoRoot,
      path: "file.txt",
      diffKind: "staged",
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.match(staged.text, /two staged/);
    assert.doesNotMatch(staged.text, /three unstaged/);

    const unstaged = repository(home, {
      operation: "diff",
      workspaceRoot,
      repoRoot: status.repoRoot,
      path: "file.txt",
      diffKind: "unstaged",
    });
    assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
    assert.match(unstaged.text, /three unstaged/);
  });
});

test("a non-repository workspace is a typed unavailable result", () => {
  withScratch(({ home }) => {
    const outside = mkdtempSync(join(tmpdir(), "pi-not-repository-"));
    try {
      const workspaceRoot = posix ? outside : outside.replaceAll("\\", "/");
      const reply = repository(home, { operation: "status", workspaceRoot });
      assert.equal(reply.ok, false);
      assert.equal(reply.reason, "notRepository");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("repository diff rejects traversal before invoking Git", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    const workspaceRoot = toLauncherPath(tree);
    const reply = repository(home, {
      operation: "diff",
      workspaceRoot,
      repoRoot: workspaceRoot,
      path: "../secret.txt",
      diffKind: "unstaged",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "invalidRequest");
  });
});

test("repository diff detects a changed repository identity", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const other = join(base, "other");
    mkdirSync(other);
    initRepository(other);
    const reply = repository(home, {
      operation: "diff",
      workspaceRoot: toLauncherPath(tree),
      repoRoot: toLauncherPath(other),
      path: "file.txt",
      diffKind: "unstaged",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "repositoryChanged");
  });
});

test("repository diff truncates oversized output without breaking the reply", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), `one\n${"x".repeat(5 * 1024 * 1024)}\n`);
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    assert.equal(status.ok, true, JSON.stringify(status));
    const reply = repository(home, {
      operation: "diff",
      workspaceRoot,
      repoRoot: status.repoRoot,
      path: "file.txt",
      diffKind: "unstaged",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.truncated, true);
    assert.ok(Buffer.byteLength(reply.text) <= 4 * 1024 * 1024);
  });
});

test("repository mutation stages, unstages, and commits only explicit index content", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "one\ntwo changed\n");
    writeFileSync(join(tree, "new.txt"), "not staged\n");
    const workspaceRoot = toLauncherPath(tree);
    const beforeStage = repository(home, { operation: "status", workspaceRoot });
    const staged = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: beforeStage.repoRoot,
      generation: generationOf(beforeStage), path: "file.txt",
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.match(staged.porcelain, /1 M\. /);
    assert.match(staged.porcelain, /\? new\.txt/);

    const unstaged = repository(home, {
      operation: "unstage", workspaceRoot, repoRoot: staged.repoRoot,
      generation: generationOf({ ...staged, operation: staged.repositoryOperation }), path: "file.txt",
    });
    assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
    assert.match(unstaged.porcelain, /1 \.M /);

    const restaged = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: unstaged.repoRoot,
      generation: generationOf({ ...unstaged, operation: unstaged.repositoryOperation }), path: "file.txt",
    });
    const hook = join(tree, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\ngit add new.txt\necho ran > hook-ran\n");
    chmodSync(hook, 0o700);
    const committed = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: restaged.repoRoot,
      generation: generationOf({ ...restaged, operation: restaged.repositoryOperation }),
      message: "reviewed file",
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.match(committed.commitOid, /^[0-9a-f]{40}$/);
    assert.equal(existsSync(join(tree, "hook-ran")), false, "repository hooks must not run");
    assert.match(committed.porcelain, /\? new\.txt/);
    assert.equal(git(tree, "show", "--format=", "--name-only", "HEAD"), "file.txt");
  });
});
test("repository operations ignore inherited Git routing environment", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const other = join(base, "other");
    mkdirSync(other);
    initRepository(other);
    writeFileSync(join(tree, "file.txt"), "changed in reviewed repository\n");
    const reply = repository(home, { operation: "status", workspaceRoot: toLauncherPath(tree) }, {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
      GIT_EXTERNAL_DIFF: join(base, "must-not-run"),
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.repoRoot.replaceAll("\\", "/").toLowerCase(), tree.replaceAll("\\", "/").toLowerCase());
    assert.match(reply.porcelain, /file\.txt/);
  });
});

test("repository mutation treats wildcard-looking paths literally", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "[a].txt"), "literal pathspec name\n");
    writeFileSync(join(tree, "a.txt"), "must remain untracked\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "[a].txt",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "[a].txt");
    assert.match(reply.porcelain, /\? a\.txt/);
  });
});


test("repository mutation supports stage and unstage before the first commit", () => {
  withScratch(({ home, tree }) => {
    git(tree, "init", "-q");
    writeFileSync(join(tree, "first.txt"), "first\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const staged = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "first.txt",
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    const unstaged = repository(home, {
      operation: "unstage", workspaceRoot, repoRoot: staged.repoRoot,
      generation: generationOf({ ...staged, operation: staged.repositoryOperation }), path: "first.txt",
    });
    assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
    assert.match(unstaged.porcelain, /\? first\.txt/);
  });
});

test("repository mutation rejects repository drift and an index lock", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "changed\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const other = join(base, "other");
    mkdirSync(other);
    initRepository(other);
    const drift = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: toLauncherPath(other),
      generation: generationOf(status), path: "file.txt",
    });
    assert.equal(drift.ok, false);
    assert.equal(drift.reason, "repositoryChanged");

    writeFileSync(join(tree, ".git", "index.lock"), "locked\n");
    const locked = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "file.txt",
    });
    assert.equal(locked.ok, false);
    assert.equal(locked.reason, "indexLocked");
    assert.equal(locked.applied, false);
  });
});

test("repository mutation refuses unresolved conflicts", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    const primary = git(tree, "branch", "--show-current");
    git(tree, "checkout", "-qb", "side");
    writeFileSync(join(tree, "file.txt"), "side\n");
    git(tree, "commit", "-qam", "side");
    git(tree, "checkout", "-q", primary);
    writeFileSync(join(tree, "file.txt"), "primary\n");
    git(tree, "commit", "-qam", "primary");
    const merge = spawnSync("git", ["merge", "side"], { cwd: tree, encoding: "utf8" });
    assert.notEqual(merge.status, 0);
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "file.txt",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "conflictsPresent");
    assert.equal(reply.applied, false);
  });
});

test("repository mutation rejects a stale generation without writing", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "changed\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    writeFileSync(join(tree, "new.txt"), "external change\n");
    const reply = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "file.txt",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "staleGeneration");
    assert.equal(reply.applied, false);
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
  });
});

test("repository generation detects a second edit with unchanged porcelain state", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "first edit\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    writeFileSync(join(tree, "file.txt"), "second edit\n");
    const current = repository(home, { operation: "status", workspaceRoot });
    assert.equal(current.porcelain, status.porcelain);
    assert.notEqual(current.generation, status.generation);
    const reply = repository(home, {
      operation: "stage", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), path: "file.txt",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "staleGeneration");
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
  });
});

test("repository commit rejects empty staged content and empty messages", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const nothing = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), message: "nothing to commit",
    });
    assert.equal(nothing.reason, "nothingStaged");
    const empty = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), message: "   ",
    });
    assert.equal(empty.reason, "emptyMessage");
  });
});

for (const filterKind of ["clean", "process"]) {
  test(`repository ${filterKind} filters fail closed before status or mutation`, () => {
    withScratch(({ home, tree }) => {
      initRepository(tree);
      writeFileSync(join(tree, ".gitattributes"), "file.txt filter=danger\n");
      git(tree, "add", ".gitattributes");
      git(tree, "commit", "-qm", "add attributes");
      writeFileSync(join(tree, "file.txt"), "reviewed change\n");
      const workspaceRoot = toLauncherPath(tree);
      const reviewed = repository(home, { operation: "status", workspaceRoot });
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
      git(tree, "config", `filter.danger.${filterKind}`, "echo ran > filter-ran");

      const blockedStatus = repository(home, { operation: "status", workspaceRoot });
      assert.equal(blockedStatus.ok, false);
      assert.equal(blockedStatus.reason, "unsafeRepositoryConfiguration");
      assert.equal(existsSync(join(tree, "filter-ran")), false, "repository filter must not execute");

      const blockedMutation = repository(home, {
        operation: "stage", workspaceRoot, repoRoot: reviewed.repoRoot,
        generation: generationOf(reviewed), path: "file.txt",
      });
      assert.equal(blockedMutation.ok, false);
      assert.equal(blockedMutation.reason, "unsafeRepositoryConfiguration");
      assert.equal(blockedMutation.applied, false);
      assert.equal(existsSync(join(tree, "filter-ran")), false, "repository filter must not execute");
      assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
    });
  });
}
test("repository commit blocks external index writes around reviewed tree creation", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "reviewed\n");
    git(tree, "add", "file.txt");
    writeFileSync(join(tree, "intruder.txt"), "not reviewed\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const lookup = posix
      ? spawnSync(shell, ["-c", "command -v git"], { encoding: "utf8" })
      : spawnSync("where", ["git"], { encoding: "utf8" });
    assert.equal(lookup.status, 0, lookup.stderr);
    const realGit = lookup.stdout.trim().split("\n")[0];
    const shellPath = spawnSync(shell, ["-c", "printf '%s' \"$PATH\""], { encoding: "utf8" });
    assert.equal(shellPath.status, 0, shellPath.stderr);
    const bin = join(home, "test-bin");
    const wrapper = join(bin, posix ? "git" : "git.cmd");
    const attempts = join(home, "index-write-attempts");
    mkdirSync(bin, { recursive: true });
    if (posix) {
      writeFileSync(wrapper, [
        "#!/bin/sh",
        "for arg in \"$@\"; do",
        "  case \"$arg\" in",
        "    write-tree|commit-tree)",
        "      env -u GIT_INDEX_FILE \"$REAL_GIT\" -C \"$TARGET_REPO\" add intruder.txt >/dev/null 2>&1",
        "      printf '%s:%s\\n' \"$arg\" \"$?\" >> \"$ATTEMPTS_FILE\"",
        "      ;;",
        "  esac",
        "done",
        "exec \"$REAL_GIT\" \"$@\"",
        "",
      ].join("\n"));
      chmodSync(wrapper, 0o700);
    } else {
      const wrapperScript = join(bin, "git-wrapper.cjs");
      writeFileSync(wrapperScript, [
        "const { appendFileSync } = require('node:fs');",
        "const { spawnSync } = require('node:child_process');",
        "const args = process.argv.slice(2);",
        "for (const arg of args) {",
        "  if (arg === 'write-tree' || arg === 'commit-tree') {",
        "    const attempt = spawnSync(process.env.REAL_GIT, ['-C', process.env.TARGET_REPO, 'add', 'intruder.txt'], { stdio: 'ignore' });",
        "    appendFileSync(process.env.ATTEMPTS_FILE, `${arg}:${attempt.status ?? 1}\\n`);",
        "  }",
        "}",
        "const result = spawnSync(process.env.REAL_GIT, args, { stdio: 'inherit' });",
        "process.exit(result.status ?? 1);",
        "",
      ].join("\n"));
      writeFileSync(wrapper, `@echo off\r\n\"${process.execPath}\" \"${wrapperScript}\" %*\r\n`);
    }
    const committed = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), message: "reviewed snapshot",
    }, {
      REAL_GIT: realGit,
      TARGET_REPO: tree,
      ATTEMPTS_FILE: attempts,
      PATH: posix ? `${bin}:${shellPath.stdout}` : `${bin};${process.env.PATH ?? ""}`,
    });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.deepEqual(readFileSync(attempts, "utf8").trim().split("\n").map((line) => line.split(":")), [
      ["write-tree", "128"], ["commit-tree", "128"],
    ]);
    assert.equal(git(tree, "show", "--format=", "--name-only", "HEAD"), "file.txt");
    assert.equal(git(tree, "status", "--porcelain", "--", "intruder.txt"), "?? intruder.txt");
  });
});
