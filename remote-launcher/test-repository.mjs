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

test("repository HTTP transport pins provenance and allowlists trusted proxy config", () => {
  const source = readFileSync(launcher, "utf8");
  assert.match(source, /stat\.uid !== 0/u);
  assert.match(source, /if \(lower\.startsWith\("remote:"\)\) return false;/u);
  assert.match(source, /lower\.startsWith\("fatal: authentication failed"\)/u);
  assert.doesNotMatch(source, /lower\.includes\("authentication failed"\)/u);
  assert.match(source, /"--no-includes", "--null",\s*"--get-urlmatch", "http\.proxy"/u);
  assert.match(
    source,
    /const configuredHttpProxy =[\s\S]*?for \(const scope of \["--system", "--global"\]\)/u,
  );
  assert.match(source, /if \(transport\.httpProxy !== null\)/u);
  assert.match(source, /`http\.proxy=\$\{transport\.httpProxy\}`/u);
  assert.match(source, /const trustedHttpTransport = \(root, remoteUrl, gitExecutable\)/u);
  assert.match(
    source,
    /const trustedHttpTransport = \(root, remoteUrl, gitExecutable\)[\s\S]*?const httpProxy = configuredHttpProxy\(root, remoteUrl, gitExecutable\);[\s\S]*?const transport = https/u,
  );
  assert.match(source, /!https && !lower\.startsWith\("http:\/\/"\)/u);
  assert.match(source, /"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"/u);
  assert.match(source, /The selected remote URL could not be resolved\./u);
  assert.match(source, /Git transport configuration could not be inspected\./u);
  assert.doesNotMatch(source, /transport\.httpProxy[^\n]+(?:console|detail|stderr)/u);
  assert.doesNotMatch(source, /failure\("remoteUnavailable", detail\)/u);
  assert.doesNotMatch(source, /remoteUnavailable: \$\{detailOf\(result\)\}/u);
});


function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function postMergeInspectionFailureEnv(home) {
  const bin = join(home, "fault-bin");
  mkdirSync(bin, { recursive: true });
  const lookup = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  const nativeGit = lookup.stdout.trim().split("\n")[0].replaceAll("'", "'\\''");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'marker="$HOME/.phase4-merge-ran"',
    'for arg in "$@"; do',
    '  if test "$arg" = "merge"; then',
    `    '${nativeGit}' "$@"`,
    "    status=$?",
    '    touch "$marker"',
    "    exit $status",
    "  fi",
    '  if test -f "$marker" && test "$arg" = "symbolic-ref"; then',
    '    echo "injected post-merge inspection failure" >&2',
    "    exit 2",
    "  fi",
    "done",
    `exec '${nativeGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function mergeExitFailureEnv(home) {
  const bin = join(home, "merge-fault-bin");
  mkdirSync(bin, { recursive: true });
  const lookup = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  const nativeGit = lookup.stdout.trim().split("\n")[0].replaceAll("'", "'\\''");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if test "$arg" = "merge"; then',
    '    echo "injected indeterminate merge failure" >&2',
    "    exit 2",
    "  fi",
    "done",
    `exec '${nativeGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function batchStageRaceEnv(home) {
  const bin = join(home, "batch-race-bin");
  mkdirSync(bin, { recursive: true });
  const lookup = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  const nativeGit = lookup.stdout.trim().split("\n")[0].replaceAll("'", "'\\''");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'root=""',
    'previous=""',
    'stage=0',
    'for arg in "$@"; do',
    '  if test "$previous" = "-C"; then root="$arg"; fi',
    '  if test "$arg" = "add"; then stage=1; fi',
    '  previous="$arg"',
    "done",
    `'${nativeGit}' "$@"`,
    "status=$?",
    'if test "$status" = 0 && test "$stage" = 1; then printf "raced\\n" > "$root/file.txt"; fi',
    "exit $status",
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function batchStageFailureEnv(home) {
  const bin = join(home, "batch-failure-bin");
  mkdirSync(bin, { recursive: true });
  const lookup = spawnSync("which", ["git"], { encoding: "utf8" });
  assert.equal(lookup.status, 0, lookup.stderr);
  const nativeGit = lookup.stdout.trim().split("\n")[0].replaceAll("'", "'\\''");
  const wrapper = join(bin, "git");
  writeFileSync(wrapper, [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if test "$arg" = "add"; then',
    '    echo "injected temporary-index staging failure" >&2',
    "    exit 2",
    "  fi",
    "done",
    `exec '${nativeGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(wrapper, 0o700);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
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

function initDivergedRepository(home, tree, base, conflict = false) {
  initRepository(tree);
  git(tree, "config", "core.autocrlf", "false");
  const remote = join(base, `phase4b-${conflict ? "conflict" : "clean"}-origin.git`);
  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  git(tree, "remote", "add", "origin", remote);
  const branch = git(tree, "branch", "--show-current");
  git(tree, "push", "-qu", "origin", branch);
  const mergeBase = git(tree, "rev-parse", "HEAD");
  const peer = join(base, `phase4b-${conflict ? "conflict" : "clean"}-peer`);
  git(base, "clone", "-q", remote, peer);
  git(peer, "config", "user.email", "peer@example.com");
  git(peer, "config", "user.name", "Peer");
  if (conflict) {
    writeFileSync(join(tree, "file.txt"), "local conflict\n");
    git(tree, "add", "file.txt");
    git(tree, "commit", "-qm", "local conflict");
    writeFileSync(join(peer, "file.txt"), "remote conflict\n");
    git(peer, "add", "file.txt");
  } else {
    writeFileSync(join(tree, "local.txt"), "local\n");
    git(tree, "add", "local.txt");
    git(tree, "commit", "-qm", "local change");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
  }
  git(peer, "commit", "-qm", conflict ? "remote conflict" : "remote change");
  git(peer, "push", "-q", "origin", branch);
  git(tree, "fetch", "-q", "origin");
  const localHead = git(tree, "rev-parse", "HEAD");
  const upstreamHead = git(peer, "rev-parse", "HEAD");
  const workspaceRoot = toLauncherPath(tree);
  const reviewed = repository(home, { operation: "status", workspaceRoot });
  assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
  assert.equal(reviewed.mergeBaseOid, mergeBase);
  return { branch, localHead, upstreamHead, mergeBase, workspaceRoot, reviewed };
}

function phase4bRequest(fixture, operation) {
  return {
    operation, workspaceRoot: fixture.workspaceRoot, repoRoot: fixture.reviewed.repoRoot,
    generation: fixture.reviewed.generation, expectedLocalBranch: fixture.branch,
    expectedHeadOid: fixture.localHead, expectedUpstreamOid: fixture.upstreamHead,
    expectedUpstreamRemote: "origin", expectedUpstreamBranch: fixture.branch,
    expectedMergeBaseOid: fixture.mergeBase,
    strategy: operation === "integrateMerge" ? "mergeCommit" : "rebaseLinear",
    ...(operation === "integrateMerge" ? { message: "Merge reviewed upstream" } : {}),
  };
}

test("repository phase 3 returns metadata and supports staged drafts and local branches", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(tree, "branch", "existing");
    writeFileSync(join(tree, "file.txt"), "one\nphase three\n");
    git(tree, "add", "file.txt");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.deepEqual(status.remotes, []);
    assert.ok(status.branches.some((branch) => branch.name === "existing"));
    assert.equal(status.upstreamRemote, null);

    const staged = repository(home, {
      operation: "stagedDiff", workspaceRoot, repoRoot: status.repoRoot, generation: status.generation,
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.match(staged.text, /phase three/);

    const staleCreate = repository(home, {
      operation: "createBranch", workspaceRoot, repoRoot: status.repoRoot, generation: status.generation,
      branchName: "stale-phase-3", expectedHeadOid: "0".repeat(40),
    });
    assert.equal(staleCreate.ok, false);
    assert.equal(staleCreate.reason, "staleGeneration");
    assert.equal(git(tree, "branch", "--list", "stale-phase-3"), "");

    const created = repository(home, {
      operation: "createBranch", workspaceRoot, repoRoot: status.repoRoot,
      generation: status.generation, branchName: "phase-3",
      expectedHeadOid: git(tree, "rev-parse", "HEAD"),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(created.branches.some((branch) => branch.name === "phase-3"));
    assert.equal(git(tree, "branch", "--show-current"), "master");

    const switched = repository(home, {
      operation: "switchBranch", workspaceRoot, repoRoot: created.repoRoot,
      generation: created.generation, branchName: "phase-3",
    });
    assert.equal(switched.ok, true, JSON.stringify(switched));
    assert.equal(git(tree, "branch", "--show-current"), "phase-3");
  });
});

test("repository Phase 3 fetches refs only and pushes the reviewed commit", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const remote = join(base, "origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    const reviewedDestination = { expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch };
    git(tree, "push", "-qu", "origin", branch);
    const initialHead = git(tree, "rev-parse", "HEAD");

    const peer = join(base, "peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
    git(peer, "commit", "-qm", "remote change");
    git(peer, "push", "-q", "origin", branch);
    const remoteHead = git(peer, "rev-parse", "HEAD");

    const workspaceRoot = toLauncherPath(tree);
    const beforeFetch = repository(home, { operation: "status", workspaceRoot });
    const currentBranch = git(tree, "branch", "--show-current");
    const worktreeText = readFileSync(join(tree, "file.txt"), "utf8");
    const fetchHead = join(tree, ".git", "FETCH_HEAD");
    assert.equal(existsSync(fetchHead), false);
    const fetched = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: beforeFetch.repoRoot,
      generation: beforeFetch.generation, remote: "origin",
    });
    assert.equal(fetched.ok, true, JSON.stringify(fetched));
    assert.equal(fetched.upstreamOid, remoteHead);
    assert.equal(git(tree, "branch", "--show-current"), currentBranch);
    assert.equal(readFileSync(join(tree, "file.txt"), "utf8"), worktreeText);
    assert.equal(existsSync(fetchHead), false, "Fetch must not write FETCH_HEAD");

    git(tree, "merge", "-q", "--ff-only", `origin/${branch}`);
    writeFileSync(join(tree, "local.txt"), "local\n");
    git(tree, "add", "local.txt");
    git(tree, "commit", "-qm", "local change");
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const reviewedHead = git(tree, "rev-parse", "HEAD");
    assert.equal(reviewed.upstreamOid, remoteHead);
    git(remote, "update-ref", "-d", `refs/heads/${branch}`);
    const deletedDestination = repository(home, {
      operation: "push", workspaceRoot, repoRoot: reviewed.repoRoot, generation: reviewed.generation,
      expectedHeadOid: reviewedHead, expectedUpstreamOid: reviewed.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(deletedDestination.ok, false);
    assert.equal(deletedDestination.applied, false);
    assert.equal(deletedDestination.reason, "nonFastForward");
    git(remote, "update-ref", `refs/heads/${branch}`, remoteHead);
    const pushed = repository(home, {
      operation: "push", workspaceRoot, repoRoot: reviewed.repoRoot, generation: reviewed.generation,
      expectedHeadOid: reviewedHead, expectedUpstreamOid: reviewed.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(pushed.ok, true, JSON.stringify(pushed));
    assert.equal(git(remote, "rev-parse", `refs/heads/${branch}`), reviewedHead);

    const nothing = repository(home, {
      operation: "push", workspaceRoot, repoRoot: pushed.repoRoot, generation: pushed.generation,
      expectedHeadOid: reviewedHead, expectedUpstreamOid: pushed.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.reason, "nothingToPush");
    assert.notEqual(reviewedHead, initialHead);
  });
});
test("repository HTTPS sync fails closed without trusted GCM and rejects repository helpers", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const remote = join(base, "origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    writeFileSync(join(tree, "local.txt"), "reviewed\n");
    git(tree, "add", "local.txt");
    git(tree, "commit", "-qm", "reviewed local change");
    git(tree, "config", "remote.origin.pushurl", "https://example.invalid/org/repo.git");

    const cleared = spawnSync("git", ["config", "--global", "credential.helper", ""], {
      encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(cleared.status, 0, cleared.stderr);
    const workspaceRoot = toLauncherPath(tree);
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const request = {
      operation: "push", workspaceRoot, repoRoot: reviewed.repoRoot, generation: reviewed.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: reviewed.upstreamOid,
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch,
    };
    const unavailable = repository(home, request, {
      GIT_ASKPASS: "hostile", GCM_INTERACTIVE: "Always", HTTPS_PROXY: "http://127.0.0.1:1",
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, "remoteAuthenticationUnavailable");
    assert.equal(unavailable.applied, false);
    assert.equal(unavailable.detail, "Git credentials for this HTTPS remote are unavailable.");
    assert.doesNotMatch(unavailable.detail, /example\.invalid|hostile|127\.0\.0\.1/);

    git(tree, "config", "remote.origin.url", "https://example.invalid/org/repo.git");
    const fetchReview = repository(home, { operation: "status", workspaceRoot });
    const fetchUnavailable = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: fetchReview.repoRoot,
      generation: fetchReview.generation, remote: "origin",
    });
    assert.equal(fetchUnavailable.ok, false);
    assert.equal(fetchUnavailable.reason, "remoteAuthenticationUnavailable");
    assert.equal(fetchUnavailable.applied, false);
    assert.equal(fetchUnavailable.detail, "Git credentials for this HTTPS remote are unavailable.");
    assert.doesNotMatch(fetchUnavailable.detail, /example\.invalid/);

    for (const [key, value] of [
      ["core.askPass", "/tmp/repository-askpass"],
      ["http.extraHeader", "Authorization: Bearer secret-token"],
      ["http.cookieFile", "/tmp/repository-cookie-jar"],
      ["http.sslKey", "/tmp/repository-client-key"],
    ]) {
      git(tree, "config", key, value);
      const httpConfigReview = repository(home, { operation: "status", workspaceRoot });
      const repositoryHttpConfig = repository(home, {
        ...request, repoRoot: httpConfigReview.repoRoot, generation: httpConfigReview.generation,
      });
      assert.equal(repositoryHttpConfig.ok, false);
      assert.equal(repositoryHttpConfig.reason, "unsafeRepositoryConfiguration");
      assert.equal(repositoryHttpConfig.applied, false);
      assert.doesNotMatch(
        repositoryHttpConfig.detail,
        /secret-token|repository-askpass|repository-cookie-jar|repository-client-key/,
      );
      git(tree, "config", "--unset-all", key);
    }

    git(tree, "config", "extensions.worktreeConfig", "true");
    git(
      tree, "config", "--worktree", "http.extraHeader",
      "Authorization: Bearer worktree-secret",
    );
    const worktreeHttpReview = repository(home, { operation: "status", workspaceRoot });
    const worktreeHttpConfig = repository(home, {
      ...request, repoRoot: worktreeHttpReview.repoRoot, generation: worktreeHttpReview.generation,
    });
    assert.equal(worktreeHttpConfig.ok, false);
    assert.equal(worktreeHttpConfig.reason, "unsafeRepositoryConfiguration");
    assert.equal(worktreeHttpConfig.applied, false);
    assert.doesNotMatch(worktreeHttpConfig.detail, /worktree-secret/);
    git(tree, "config", "--worktree", "--unset-all", "http.extraHeader");

    git(tree, "config", "credential.helper", "store");
    const helperReview = repository(home, { operation: "status", workspaceRoot });
    const repositoryHelper = repository(home, {
      ...request, repoRoot: helperReview.repoRoot, generation: helperReview.generation,
    });
    assert.equal(repositoryHelper.ok, false);
    assert.equal(repositoryHelper.reason, "unsafeRepositoryConfiguration");
    assert.equal(repositoryHelper.applied, false);
  });
});

test("repository HTTP preflight ignores PATH Git and redacts proxy failures", { skip: !posix }, () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const remote = join(base, "origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    git(tree, "config", "remote.origin.url", "http://example.invalid/org/repo.git");

    const proxySecret = "proxy-user:proxy-secret";
    const configured = spawnSync(
      "git",
      ["config", "--global", "http.proxy", `http://${proxySecret}@127.0.0.1:1`],
      { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    assert.equal(configured.status, 0, configured.stderr);

    const hostileBin = join(base, "hostile-bin");
    const marker = join(base, "path-git-ran");
    mkdirSync(hostileBin);
    const lookup = spawnSync("which", ["git"], { encoding: "utf8" });
    assert.equal(lookup.status, 0, lookup.stderr);
    const nativeGit = lookup.stdout.trim().split("\n")[0].replaceAll("'", "'\\''");
    const escapedMarker = marker.replaceAll("'", "'\\''");
    const wrapper = join(hostileBin, "git");
    writeFileSync(wrapper, [
      "#!/bin/sh",
      "for arg in \"$@\"; do",
      "  if test \"$arg\" = \"--system\" || test \"$arg\" = \"--global\"; then",
      `    touch '${escapedMarker}'`,
      "  fi",
      "done",
      `exec '${nativeGit}' \"$@\"`,
      "",
    ].join("\n"));
    chmodSync(wrapper, 0o700);

    const workspaceRoot = toLauncherPath(tree);
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, remote: "origin",
    }, {
      PATH: `${hostileBin}:${process.env.PATH ?? ""}`,
      HTTP_PROXY: "http://ambient-user:ambient-secret@127.0.0.1:2",
      HTTPS_PROXY: "http://ambient-user:ambient-secret@127.0.0.1:2",
    });

    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "remoteUnavailable");
    assert.equal(reply.applied, false);
    assert.equal(reply.detail, "The trusted Git HTTP proxy configuration is invalid.");
    assert.equal(existsSync(marker), false, "PATH Git must not inspect trusted config scopes");
    assert.doesNotMatch(JSON.stringify(reply), /proxy-secret|ambient-secret|example\.invalid/);
  });
});

test("repository HTTP preflight rejects non-whitespace proxy control characters", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(tree, "remote", "add", "origin", "http://example.invalid/org/repo.git");
    const workspaceRoot = toLauncherPath(tree);
    const reviewed = repository(home, { operation: "status", workspaceRoot });

    for (const control of ["\u0001", "\u001b", "\u007f"]) {
      const configured = spawnSync(
        "git",
        ["config", "--global", "http.proxy", `http://127.0.0.1:1/${control}`],
        { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
      );
      assert.equal(configured.status, 0, configured.stderr);
      const reply = repository(home, {
        operation: "fetch", workspaceRoot, repoRoot: reviewed.repoRoot,
        generation: reviewed.generation, remote: "origin",
      });
      assert.equal(reply.ok, false);
      assert.equal(reply.reason, "remoteUnavailable");
      assert.equal(reply.applied, false);
      assert.equal(reply.detail, "The trusted Git HTTP proxy configuration is invalid.");
      assert.doesNotMatch(JSON.stringify(reply), /example\.invalid|127\.0\.0\.1/);
    }
  });
});

test("repository HTTPS preflight validates proxy before credential selection", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(tree, "remote", "add", "origin", "https://example.invalid/org/repo.git");
    const configured = spawnSync(
      "git",
      ["config", "--global", "http.proxy", "http://proxy-user:proxy-secret@127.0.0.1:1"],
      { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
    );
    assert.equal(configured.status, 0, configured.stderr);

    const workspaceRoot = toLauncherPath(tree);
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, remote: "origin",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "remoteUnavailable");
    assert.equal(reply.applied, false);
    assert.equal(reply.detail, "The trusted Git HTTP proxy configuration is invalid.");
    assert.doesNotMatch(
      JSON.stringify(reply),
      /proxy-user|proxy-secret|example\.invalid|127\.0\.0\.1/,
    );
  });
});

test("repository HTTP preflight redacts credential-bearing remote URLs", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(
      tree, "remote", "add", "origin",
      "https://remote-user:remote-secret@example.invalid/org/repo.git",
    );
    const workspaceRoot = toLauncherPath(tree);
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, remote: "origin",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "unsafeRepositoryConfiguration");
    assert.equal(reply.applied, false);
    assert.doesNotMatch(
      JSON.stringify(reply),
      /remote-user|remote-secret|example\.invalid/,
    );
  });
});

test("repository HTTP proxy tri-state honors URL-matched explicit-empty values", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(tree, "remote", "add", "origin", "http://127.0.0.1:9/org/repo.git");
    const workspaceRoot = toLauncherPath(tree);
    const configureGlobalProxy = (value, key = "http.proxy") => {
      const configured = spawnSync("git", ["config", "--global", key, value], {
        encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.equal(configured.status, 0, configured.stderr);
    };

    configureGlobalProxy("http://127.0.0.1:1");
    const configuredReview = repository(home, { operation: "status", workspaceRoot });
    const configured = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: configuredReview.repoRoot,
      generation: configuredReview.generation, remote: "origin",
    }, {
      HTTP_PROXY: "http://ambient-user:ambient-secret@127.0.0.1:2",
      HTTPS_PROXY: "http://ambient-user:ambient-secret@127.0.0.1:2",
    });
    assert.equal(configured.ok, false);
    assert.equal(configured.reason, "remoteUnavailable");
    assert.equal(
      configured.detail,
      "Git could not reach the selected remote through the configured trusted proxy.",
    );

    configureGlobalProxy("", "http.http://127.0.0.1:9.proxy");
    const disabledReview = repository(home, { operation: "status", workspaceRoot });
    const disabled = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: disabledReview.repoRoot,
      generation: disabledReview.generation, remote: "origin",
    }, {
      ALL_PROXY: "http://ambient-user:ambient-secret@127.0.0.1:2",
      NO_PROXY: "ambient-secret",
    });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.reason, "remoteUnavailable");
    assert.equal(disabled.detail, "Git could not reach the selected remote.");
    assert.doesNotMatch(JSON.stringify([configured, disabled]), /ambient-secret|127\.0\.0\.1/);
  });
});

test("repository Phase 4 integrates only a reviewed clean fast-forward", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    git(tree, "config", "core.autocrlf", "false");
    const remote = join(base, "origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    const localHead = git(tree, "rev-parse", "HEAD");
    const peer = join(base, "phase4-peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "generated.txt"), "reviewed upstream\n");
    git(peer, "add", "generated.txt");
    git(peer, "commit", "-qm", "reviewed upstream");
    git(peer, "push", "-q", "origin", branch);
    const upstreamHead = git(peer, "rev-parse", "HEAD");
    const workspaceRoot = toLauncherPath(tree);
    const beforeFetch = repository(home, { operation: "status", workspaceRoot });
    const fetched = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: beforeFetch.repoRoot,
      generation: beforeFetch.generation, remote: "origin",
    });
    assert.equal(fetched.ok, true, JSON.stringify(fetched));
    assert.equal(fetched.mergeBaseOid, localHead);
    writeFileSync(join(tree, ".git", "info", "exclude"), "generated.txt\n");
    writeFileSync(join(tree, "generated.txt"), "local ignored content\n");
    const reviewed = repository(home, { operation: "status", workspaceRoot });
    const request = {
      operation: "integrateFastForward", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, expectedLocalBranch: branch, expectedHeadOid: localHead,
      expectedUpstreamOid: upstreamHead, expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: branch, expectedMergeBaseOid: localHead, strategy: "fastForwardOnly",
    };
    const collision = repository(home, request);
    assert.equal(collision.ok, false);
    assert.equal(collision.reason, "dirtyWorktree");
    assert.equal(git(tree, "rev-parse", "HEAD"), localHead);
    rmSync(join(tree, "generated.txt"));
    const hook = join(tree, ".git", "hooks", "post-merge");
    writeFileSync(hook, "#!/bin/sh\necho ran > hook-ran\n");
    chmodSync(hook, 0o700);
    const integrated = repository(home, request);
    assert.equal(integrated.ok, true, JSON.stringify(integrated));
    assert.equal(integrated.applied, true);
    assert.equal(git(tree, "rev-parse", "HEAD"), upstreamHead);
    assert.equal(git(tree, "branch", "--show-current"), branch);
    assert.equal(existsSync(join(tree, "hook-ran")), false, "post-merge hook must not run");
  });
});

test("repository Phase 4B creates only the reviewed two-parent merge without hooks", () => {
  withScratch(({ home, tree, base }) => {
    const fixture = initDivergedRepository(home, tree, base);
    const hook = join(tree, ".git", "hooks", "post-merge");
    writeFileSync(hook, "#!/bin/sh\necho ran > hook-ran\n");
    chmodSync(hook, 0o700);
    const untrimmed = repository(home, {
      ...phase4bRequest(fixture, "integrateMerge"),
      message: " Merge reviewed upstream ",
    });
    assert.equal(untrimmed.ok, false);
    assert.equal(untrimmed.reason, "invalidRequest");
    assert.equal(untrimmed.applied, false);
    assert.equal(git(tree, "rev-parse", "HEAD"), fixture.localHead);
    const result = repository(home, phase4bRequest(fixture, "integrateMerge"));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied, true);
    const finalHead = git(tree, "rev-parse", "HEAD");
    assert.deepEqual(
      git(tree, "rev-list", "--parents", "-n", "1", finalHead).split(/\s+/),
      [finalHead, fixture.localHead, fixture.upstreamHead],
    );
    assert.equal(git(tree, "log", "-1", "--format=%B"), "Merge reviewed upstream");
    assert.equal(existsSync(join(tree, "hook-ran")), false, "post-merge hook must not run");
  });
});

test("repository Phase 4B rebases only the reviewed linear range without hooks", () => {
  withScratch(({ home, tree, base }) => {
    const fixture = initDivergedRepository(home, tree, base);
    const hook = join(tree, ".git", "hooks", "post-rewrite");
    writeFileSync(hook, "#!/bin/sh\necho ran > hook-ran\n");
    chmodSync(hook, 0o700);
    const result = repository(home, phase4bRequest(fixture, "integrateRebase"));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.applied, true);
    const finalHead = git(tree, "rev-parse", "HEAD");
    assert.notEqual(finalHead, fixture.localHead);
    assert.equal(git(tree, "rev-list", "--count", `${fixture.upstreamHead}..${finalHead}`), "1");
    assert.equal(git(tree, "merge-base", fixture.upstreamHead, finalHead), fixture.upstreamHead);
    assert.equal(existsSync(join(tree, "hook-ran")), false, "post-rewrite hook must not run");
  });
});

test("repository Phase 4B aborts merge and rebase conflicts and verifies exact restoration", () => {
  withScratch(({ home, tree, base }) => {
    const fixture = initDivergedRepository(home, tree, base, true);
    for (const operation of ["integrateMerge", "integrateRebase"]) {
      const result = repository(home, phase4bRequest(fixture, operation));
      assert.equal(result.ok, false);
      assert.equal(result.reason, "integrationConflict", JSON.stringify(result));
      assert.equal(result.applied, false);
      assert.equal(git(tree, "branch", "--show-current"), fixture.branch);
      assert.equal(git(tree, "rev-parse", "HEAD"), fixture.localHead);
      assert.equal(git(tree, "status", "--porcelain=v1"), "");
      assert.equal(existsSync(join(tree, ".git", "MERGE_HEAD")), false);
      assert.equal(existsSync(join(tree, ".git", "rebase-merge")), false);
      assert.equal(existsSync(join(tree, ".git", "rebase-apply")), false);
      assert.equal(existsSync(join(tree, ".git", "index.lock")), false);
    }
  });
});
test("repository Phase 4B rejects included and worktree-scoped executable Git configuration", () => {
  withScratch(({ home, tree, base }) => {
    const fixture = initDivergedRepository(home, tree, base);
    const included = join(tree, ".git", "phase4b-unsafe.config");
    writeFileSync(included, "[merge \"reviewed\"]\n\tdriver = should-not-run %O %A %B\n");
    git(tree, "config", "--local", "include.path", included);
    const result = repository(home, phase4bRequest(fixture, "integrateMerge"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsafeRepositoryConfiguration", JSON.stringify(result));
    assert.equal(git(tree, "rev-parse", "HEAD"), fixture.localHead);
  });

  withScratch(({ home, tree, base }) => {
    const fixture = initDivergedRepository(home, tree, base);
    git(tree, "config", "extensions.worktreeConfig", "true");
    git(tree, "config", "--worktree", "merge.reviewed.driver", "should-not-run %O %A %B");
    const result = repository(home, phase4bRequest(fixture, "integrateRebase"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unsafeRepositoryConfiguration", JSON.stringify(result));
    assert.equal(git(tree, "rev-parse", "HEAD"), fixture.localHead);
  });
});


test("repository Phase 4 reports applied refresh failure when post-merge inspection fails", { skip: !posix }, () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    git(tree, "config", "core.autocrlf", "false");
    const remote = join(base, "phase4-refresh-origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    const localHead = git(tree, "rev-parse", "HEAD");
    const peer = join(base, "phase4-refresh-peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
    git(peer, "commit", "-qm", "remote");
    git(peer, "push", "-q", "origin", branch);
    const upstreamHead = git(peer, "rev-parse", "HEAD");
    const workspaceRoot = toLauncherPath(tree);
    const beforeFetch = repository(home, { operation: "status", workspaceRoot });
    const reviewed = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: beforeFetch.repoRoot,
      generation: beforeFetch.generation, remote: "origin",
    });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    const reply = repository(home, {
      operation: "integrateFastForward", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, expectedLocalBranch: branch, expectedHeadOid: localHead,
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch,
      expectedUpstreamOid: upstreamHead, expectedMergeBaseOid: localHead, strategy: "fastForwardOnly",
    }, postMergeInspectionFailureEnv(home));
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "refreshFailed");
    assert.equal(reply.applied, true);
    assert.match(reply.detail, /could not be inspected/);
    assert.equal(git(tree, "rev-parse", "HEAD"), upstreamHead);
  });
});

test("repository Phase 4 treats a nonzero merge as potentially applied", { skip: !posix }, () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    git(tree, "config", "core.autocrlf", "false");
    const remote = join(base, "phase4-failed-merge-origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    const localHead = git(tree, "rev-parse", "HEAD");
    const peer = join(base, "phase4-failed-merge-peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
    git(peer, "commit", "-qm", "remote");
    git(peer, "push", "-q", "origin", branch);
    const upstreamHead = git(peer, "rev-parse", "HEAD");
    const workspaceRoot = toLauncherPath(tree);
    const beforeFetch = repository(home, { operation: "status", workspaceRoot });
    const reviewed = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: beforeFetch.repoRoot,
      generation: beforeFetch.generation, remote: "origin",
    });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    const reply = repository(home, {
      operation: "integrateFastForward", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, expectedLocalBranch: branch, expectedHeadOid: localHead,
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch,
      expectedUpstreamOid: upstreamHead, expectedMergeBaseOid: localHead, strategy: "fastForwardOnly",
    }, mergeExitFailureEnv(home));
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "refreshFailed");
    assert.equal(reply.applied, true);
    assert.match(reply.detail, /may have changed/);
    assert.equal(git(tree, "rev-parse", "HEAD"), localHead);
  });
});

test("repository Phase 4 rejects stale, dirty, active, locked, detached, unborn, and divergent state", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    git(tree, "config", "core.autocrlf", "false");
    const remote = join(base, "phase4-origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    git(tree, "push", "-qu", "origin", branch);
    const baseOid = git(tree, "rev-parse", "HEAD");
    const peer = join(base, "phase4-negative-peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "remote.txt"), "remote\n");
    git(peer, "add", "remote.txt");
    git(peer, "commit", "-qm", "remote");
    git(peer, "push", "-q", "origin", branch);
    const upstreamOid = git(peer, "rev-parse", "HEAD");
    const workspaceRoot = toLauncherPath(tree);
    const beforeFetch = repository(home, { operation: "status", workspaceRoot });
    const fetched = repository(home, {
      operation: "fetch", workspaceRoot, repoRoot: beforeFetch.repoRoot,
      generation: beforeFetch.generation, remote: "origin",
    });
    assert.equal(fetched.ok, true, JSON.stringify(fetched));
    const requestFor = (reviewed, overrides = {}) => ({
      operation: "integrateFastForward", workspaceRoot, repoRoot: reviewed.repoRoot,
      generation: reviewed.generation, expectedLocalBranch: branch,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"),
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch,
      expectedUpstreamOid: upstreamOid, expectedMergeBaseOid: reviewed.mergeBaseOid,
      strategy: "fastForwardOnly", ...overrides,
    });

    const extra = repository(home, requestFor(fetched, { unexpected: true }));
    assert.equal(extra.reason, "invalidRequest");
    assert.equal(extra.applied, false);

    const staleHead = repository(home, requestFor(fetched, { expectedHeadOid: "0".repeat(40) }));
    assert.equal(staleHead.reason, "staleGeneration");
    assert.equal(staleHead.applied, false);

    const staleBranch = repository(home, requestFor(fetched, { expectedLocalBranch: "reviewed-other" }));
    assert.equal(staleBranch.reason, "staleGeneration");
    assert.equal(staleBranch.applied, false);

    const staleUpstreamBranch = repository(home, requestFor(fetched, { expectedUpstreamBranch: "reviewed-other" }));
    assert.equal(staleUpstreamBranch.reason, "staleGeneration");
    assert.equal(staleUpstreamBranch.applied, false);

    const staleUpstreamOid = repository(home, requestFor(fetched, { expectedUpstreamOid: baseOid }));
    assert.equal(staleUpstreamOid.reason, "staleGeneration");
    assert.equal(staleUpstreamOid.applied, false);

    const staleMergeBase = repository(home, requestFor(fetched, { expectedMergeBaseOid: upstreamOid }));
    assert.equal(staleMergeBase.reason, "staleGeneration");
    assert.equal(staleMergeBase.applied, false);

    const lockedReview = repository(home, { operation: "status", workspaceRoot });
    writeFileSync(join(tree, ".git", "index.lock"), "locked\n");
    const locked = repository(home, requestFor(lockedReview));
    assert.equal(locked.reason, "indexLocked");
    assert.equal(locked.applied, false);
    rmSync(join(tree, ".git", "index.lock"));

    writeFileSync(join(tree, ".git", "MERGE_HEAD"), `${upstreamOid}\n`);
    const activeReview = repository(home, { operation: "status", workspaceRoot });
    const active = repository(home, requestFor(activeReview));
    assert.equal(active.reason, "operationInProgress");
    assert.equal(active.applied, false);
    rmSync(join(tree, ".git", "MERGE_HEAD"));


    const gitDir = git(tree, "rev-parse", "--absolute-git-dir");
    mkdirSync(join(gitDir, "sequencer"));
    const sequencerReview = repository(home, { operation: "status", workspaceRoot });
    assert.equal(sequencerReview.operation, "cherryPick", JSON.stringify(sequencerReview));
    const sequencerActive = repository(home, requestFor(sequencerReview));
    assert.equal(sequencerActive.reason, "operationInProgress");
    assert.equal(sequencerActive.applied, false);
    rmSync(join(gitDir, "sequencer"), { recursive: true });
    writeFileSync(join(tree, "dirty.txt"), "dirty\n");
    const dirtyReview = repository(home, { operation: "status", workspaceRoot });
    const dirty = repository(home, requestFor(dirtyReview));
    assert.equal(dirty.reason, "dirtyWorktree");
    assert.equal(dirty.applied, false);
    rmSync(join(tree, "dirty.txt"));

    git(tree, "switch", "-q", "--detach");
    const detachedReview = repository(home, { operation: "status", workspaceRoot });
    const detached = repository(home, requestFor(detachedReview, { expectedMergeBaseOid: baseOid }));
    assert.equal(detached.reason, "detachedHead");
    assert.equal(detached.applied, false);
    git(tree, "switch", "-q", branch);

    const unbornTree = join(base, "phase4-unborn");
    mkdirSync(unbornTree);
    git(unbornTree, "init", "-q");
    git(unbornTree, "remote", "add", "origin", remote);
    git(unbornTree, "fetch", "-q", "origin", branch);
    git(unbornTree, "config", `branch.${branch}.remote`, "origin");
    git(unbornTree, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
    const unbornWorkspaceRoot = toLauncherPath(unbornTree);
    const unbornReview = repository(home, { operation: "status", workspaceRoot: unbornWorkspaceRoot });
    assert.equal(unbornReview.ok, false);
    assert.equal(unbornReview.reason, "gitUnavailable");
    assert.match(unbornReview.detail, /HEAD/);
    assert.equal(unbornReview.applied, false);

    writeFileSync(join(tree, "local.txt"), "local\n");
    git(tree, "add", "local.txt");
    git(tree, "commit", "-qm", "local");
    const divergentReview = repository(home, { operation: "status", workspaceRoot });
    assert.equal(divergentReview.mergeBaseOid, baseOid);
    const divergent = repository(home, requestFor(divergentReview));
    assert.equal(divergent.reason, "nonFastForward");
    assert.equal(divergent.applied, false);
    assert.equal(git(tree, "rev-parse", "HEAD"), divergentReview.branches.find((item) => item.name === branch).oid);
  });
});


test("repository Phase 3 rejects stale, unsafe, detached, and non-fast-forward pushes", () => {
  withScratch(({ home, tree, base }) => {
    initRepository(tree);
    const remote = join(base, "origin.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "-q");
    git(tree, "remote", "add", "origin", remote);
    const branch = git(tree, "branch", "--show-current");
    const reviewedDestination = { expectedUpstreamRemote: "origin", expectedUpstreamBranch: branch };
    git(tree, "push", "-qu", "origin", branch);
    const workspaceRoot = toLauncherPath(tree);

    writeFileSync(join(tree, "local.txt"), "reviewed\n");
    git(tree, "add", "local.txt");
    git(tree, "commit", "-qm", "reviewed local change");
    const staleHeadStatus = repository(home, { operation: "status", workspaceRoot });
    writeFileSync(join(tree, "later.txt"), "later\n");
    git(tree, "add", "later.txt");
    git(tree, "commit", "-qm", "later local change");
    const staleHead = repository(home, {
      operation: "push", workspaceRoot, repoRoot: staleHeadStatus.repoRoot,
      generation: staleHeadStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD~1"),
      expectedUpstreamOid: staleHeadStatus.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(staleHead.ok, false);
    assert.equal(staleHead.reason, "staleGeneration");

    const staleUpstreamStatus = repository(home, { operation: "status", workspaceRoot });
    git(tree, "update-ref", `refs/remotes/origin/${branch}`, git(tree, "rev-parse", "HEAD"));
    const staleUpstream = repository(home, {
      operation: "push", workspaceRoot, repoRoot: staleUpstreamStatus.repoRoot,
      generation: staleUpstreamStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD"),
      expectedUpstreamOid: staleUpstreamStatus.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(staleUpstream.ok, false);
    assert.equal(staleUpstream.reason, "staleGeneration");
    git(tree, "fetch", "-q", "origin");

    const staleDestinationStatus = repository(home, { operation: "status", workspaceRoot });
    const staleDestination = repository(home, {
      operation: "push", workspaceRoot, repoRoot: staleDestinationStatus.repoRoot,
      generation: staleDestinationStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD"),
      expectedUpstreamOid: staleDestinationStatus.upstreamOid,
      expectedUpstreamRemote: "origin", expectedUpstreamBranch: `${branch}-changed`,
    });
    assert.equal(staleDestination.ok, false);
    assert.equal(staleDestination.reason, "staleGeneration");

    const peer = join(base, "peer");
    git(base, "clone", "-q", remote, peer);
    git(peer, "config", "user.email", "peer@example.com");
    git(peer, "config", "user.name", "Peer");
    writeFileSync(join(peer, "peer.txt"), "peer\n");
    git(peer, "add", "peer.txt");
    git(peer, "commit", "-qm", "peer change");
    git(peer, "push", "-q", "origin", branch);
    const diverged = repository(home, { operation: "status", workspaceRoot });
    const rejected = repository(home, {
      operation: "push", workspaceRoot, repoRoot: diverged.repoRoot, generation: diverged.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: diverged.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "nonFastForward");

    git(tree, "config", "Remote.origin.PushURL", "ext::malicious");
    const unsafeStatus = repository(home, { operation: "status", workspaceRoot });
    const unsafe = repository(home, {
      operation: "push", workspaceRoot, repoRoot: unsafeStatus.repoRoot, generation: unsafeStatus.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: unsafeStatus.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.reason, "unsafeRepositoryConfiguration");
    git(tree, "config", "--unset", "remote.origin.pushurl");

    for (const unsafeHttpsUrl of [
      "https://user:secret-token@example.com/org/repo.git",
      "https://token@example.com/org/repo.git",
      "https://@example.com/org/repo.git",
      "https:///org/repo.git",
      "https://example.com\\org\\repo.git",
      "https://example.com\\@attacker.invalid/org/repo.git",
      "https://example.com/org/repo.git?token=secret-token",
      "https://example.com/org/repo.git#secret-token",
      "https://example.com/error: 403/repo.git",
    ]) {
      git(tree, "config", "remote.origin.pushurl", unsafeHttpsUrl);
      const unsafeHttpsStatus = repository(home, { operation: "status", workspaceRoot });
      const unsafeHttps = repository(home, {
        operation: "push", workspaceRoot, repoRoot: unsafeHttpsStatus.repoRoot,
        generation: unsafeHttpsStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD"),
        expectedUpstreamOid: unsafeHttpsStatus.upstreamOid, ...reviewedDestination,
      });
      assert.equal(unsafeHttps.ok, false);
      assert.equal(unsafeHttps.reason, "unsafeRepositoryConfiguration");
      assert.doesNotMatch(unsafeHttps.detail ?? "", /secret-token/);
    }
    git(tree, "config", "--unset", "remote.origin.pushurl");

    const secondRemote = join(base, "second.git");
    mkdirSync(secondRemote);
    git(secondRemote, "init", "--bare", "-q");
    git(tree, "config", "--add", "remote.origin.pushurl", remote);
    git(tree, "config", "--add", "remote.origin.pushurl", secondRemote);
    const multiDestinationStatus = repository(home, { operation: "status", workspaceRoot });
    const multiDestination = repository(home, {
      operation: "push", workspaceRoot, repoRoot: multiDestinationStatus.repoRoot,
      generation: multiDestinationStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD"),
      expectedUpstreamOid: multiDestinationStatus.upstreamOid, ...reviewedDestination,
    });
    assert.equal(multiDestination.ok, false);
    assert.equal(multiDestination.reason, "unsafeRepositoryConfiguration");
    assert.throws(() => git(secondRemote, "rev-parse", `refs/heads/${branch}`));
    git(tree, "config", "--unset-all", "remote.origin.pushurl");

    git(tree, "config", `URL.ext::.PushInsteadOf`, remote);
    const rewrittenStatus = repository(home, { operation: "status", workspaceRoot });
    const rewritten = repository(home, {
      operation: "push", workspaceRoot, repoRoot: rewrittenStatus.repoRoot, generation: rewrittenStatus.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: rewrittenStatus.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(rewritten.ok, false);
    assert.equal(rewritten.reason, "unsafeRepositoryConfiguration");
    git(tree, "config", "--unset-all", `url.ext::.pushInsteadOf`);

    git(tree, "config", "HTTP.Proxy", "http://127.0.0.1:1");
    const proxiedStatus = repository(home, { operation: "status", workspaceRoot });
    const proxied = repository(home, {
      operation: "push", workspaceRoot, repoRoot: proxiedStatus.repoRoot, generation: proxiedStatus.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: proxiedStatus.upstreamOid,
      ...reviewedDestination,
    });
    assert.equal(proxied.ok, false);
    assert.equal(proxied.reason, "unsafeRepositoryConfiguration");
    git(tree, "config", "--unset-all", "http.proxy");

    const malformedUpstreamStatus = repository(home, { operation: "status", workspaceRoot });
    git(tree, "config", `branch.${branch}.merge`, "refs/heads/main:refs/heads/other");
    const malformedUpstream = repository(home, {
      operation: "push", workspaceRoot, repoRoot: malformedUpstreamStatus.repoRoot,
      generation: malformedUpstreamStatus.generation, expectedHeadOid: git(tree, "rev-parse", "HEAD"),
      expectedUpstreamOid: null, expectedUpstreamRemote: "origin",
      expectedUpstreamBranch: "main:refs/heads/other",
    });
    assert.equal(malformedUpstream.ok, false);
    assert.equal(malformedUpstream.reason, "unsafeRepositoryConfiguration");
    git(tree, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);

    git(tree, "checkout", "-q", "--detach");
    const detachedStatus = repository(home, { operation: "status", workspaceRoot });
    const detached = repository(home, {
      operation: "push", workspaceRoot, repoRoot: detachedStatus.repoRoot, generation: detachedStatus.generation,
      expectedHeadOid: git(tree, "rev-parse", "HEAD"), expectedUpstreamOid: null,
      ...reviewedDestination,
    });
    assert.equal(detached.ok, false);
    assert.equal(detached.reason, "detachedHead");
  });
});

test("repository Phase 3 never stashes or overwrites changes while switching branches", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    const original = git(tree, "branch", "--show-current");
    git(tree, "checkout", "-qb", "conflicting");
    writeFileSync(join(tree, "file.txt"), "branch version\n");
    git(tree, "add", "file.txt");
    git(tree, "commit", "-qm", "branch version");
    git(tree, "checkout", "-q", original);
    writeFileSync(join(tree, "file.txt"), "local version\n");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "switchBranch", workspaceRoot, repoRoot: status.repoRoot,
      generation: status.generation, branchName: "conflicting",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "checkoutConflict");
    assert.equal(git(tree, "branch", "--show-current"), original);
    assert.equal(readFileSync(join(tree, "file.txt"), "utf8"), "local version\n");
    assert.equal(git(tree, "stash", "list"), "");
  });
});
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
test("repository batch mutation stages and unstages the exact reviewed set in one request", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "changed tracked file\n");
    writeFileSync(join(tree, "new.txt"), "new file\n");
    writeFileSync(join(tree, "left-alone.txt"), "not reviewed\n");
    const workspaceRoot = toLauncherPath(tree);
    const before = repository(home, { operation: "status", workspaceRoot });
    const staged = repository(home, {
      operation: "stageBatch", workspaceRoot, repoRoot: before.repoRoot,
      generation: generationOf(before),
      files: [
        { path: "file.txt", originalPath: null },
        { path: "new.txt", originalPath: null },
      ],
    });
    assert.equal(staged.ok, true, JSON.stringify(staged));
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "file.txt\nnew.txt");
    assert.match(staged.porcelain, /\? left-alone\.txt/);

    const unstaged = repository(home, {
      operation: "unstageBatch", workspaceRoot, repoRoot: staged.repoRoot,
      generation: generationOf(staged),
      files: [
        { path: "file.txt", originalPath: null },
        { path: "new.txt", originalPath: null },
      ],
    });
    assert.equal(unstaged.ok, true, JSON.stringify(unstaged));
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
  });
});

test("repository batch staging rejects worktree drift before installing the index", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "reviewed change\n");
    const workspaceRoot = toLauncherPath(tree);
    const before = repository(home, { operation: "status", workspaceRoot });
    const rejected = repository(home, {
      operation: "stageBatch", workspaceRoot, repoRoot: before.repoRoot,
      generation: generationOf(before),
      files: [{ path: "file.txt", originalPath: null }],
    }, batchStageRaceEnv(home));
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.reason, "staleGeneration");
    assert.equal(rejected.applied, false);
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
    assert.equal(readFileSync(join(tree, "file.txt"), "utf8"), "raced\n");
  });
});

test("repository batch staging reports temporary-index Git failure as non-applied", { skip: !posix }, () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "reviewed change\n");
    const workspaceRoot = toLauncherPath(tree);
    const before = repository(home, { operation: "status", workspaceRoot });
    const rejected = repository(home, {
      operation: "stageBatch", workspaceRoot, repoRoot: before.repoRoot,
      generation: generationOf(before),
      files: [{ path: "file.txt", originalPath: null }],
    }, batchStageFailureEnv(home));
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(rejected.reason, "gitUnavailable");
    assert.equal(rejected.applied, false);
    assert.match(rejected.detail, /temporary-index staging failure/);
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
  });
});

test("repository batch mutation rejects duplicate logical paths before changing the index", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "file.txt"), "changed tracked file\n");
    const workspaceRoot = toLauncherPath(tree);
    const before = repository(home, { operation: "status", workspaceRoot });
    const rejected = repository(home, {
      operation: "stageBatch", workspaceRoot, repoRoot: before.repoRoot,
      generation: generationOf(before),
      files: [
        { path: "file.txt", originalPath: null },
        { path: "file.txt", originalPath: null },
      ],
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "invalidRequest");
    assert.equal(rejected.applied, false);
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
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

test("repository commit uses global identity and ignores inherited Git identity", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    git(tree, "config", "--unset", "user.name");
    git(tree, "config", "--unset", "user.email");
    for (const [key, value] of [["user.name", "Global Repository User"],
      ["user.email", "global-repository@example.com"]]) {
      const configured = spawnSync("git", ["config", "--global", key, value], {
        encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.equal(configured.status, 0, configured.stderr);
    }
    writeFileSync(join(tree, "reviewed.txt"), "reviewed\n");
    git(tree, "add", "reviewed.txt");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), message: "global identity",
    }, {
      GIT_AUTHOR_NAME: "Hostile Author", GIT_AUTHOR_EMAIL: "hostile-author@example.com",
      GIT_COMMITTER_NAME: "Hostile Committer", GIT_COMMITTER_EMAIL: "hostile-committer@example.com",
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.applied, true);
    assert.equal(
      git(tree, "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce", "HEAD"),
      "Global Repository User\0global-repository@example.com\0Global Repository User\0global-repository@example.com",
    );
    assert.equal(git(tree, "diff", "--cached", "--name-only"), "");
  });
});

test("repository commit reports identityUnavailable without changing HEAD or index", () => {
  withScratch(({ home, tree }) => {
    initRepository(tree);
    writeFileSync(join(tree, "reviewed.txt"), "reviewed\n");
    git(tree, "add", "reviewed.txt");
    git(tree, "config", "user.name", "");
    git(tree, "config", "user.email", "");
    git(tree, "config", "user.useConfigOnly", "true");
    const oldHead = git(tree, "rev-parse", "HEAD");
    const oldIndex = git(tree, "diff", "--cached", "--binary");
    const workspaceRoot = toLauncherPath(tree);
    const status = repository(home, { operation: "status", workspaceRoot });
    const reply = repository(home, {
      operation: "commit", workspaceRoot, repoRoot: status.repoRoot,
      generation: generationOf(status), message: "must not commit",
    });
    assert.equal(reply.ok, false);
    assert.equal(reply.reason, "identityUnavailable");
    assert.equal(reply.applied, false);
    assert.equal(git(tree, "rev-parse", "HEAD"), oldHead);
    assert.equal(git(tree, "diff", "--cached", "--binary"), oldIndex);
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
