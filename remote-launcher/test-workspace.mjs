import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launcher = resolve("remote-launcher/pi-desktop-launcher");
const shell = process.env.SHELL || "sh";
const posix = process.platform !== "win32";

/**
 * The launcher only accepts absolute POSIX paths, and native Windows Node cannot
 * resolve an MSYS path like `/c/Users/...`. But Node on Windows *does* resolve a
 * leading `/` against the current drive — so a scratch directory inside the repo,
 * which is on the same drive as the launcher's cwd, has a working `/`-rooted form.
 * That is what lets this whole suite run locally instead of only on a real host.
 */
/**
 * Two different translations, and conflating them is the trap. The MSYS shell resolves
 * a leading `/` against its own root, so anything it must *exec* needs `/c/...`. Native
 * Windows Node resolves a leading `/` against the current drive, so anything that
 * travels inside a launcher payload needs the drive stripped instead.
 */
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

  // MSYS sh can read fd 3, but native Windows Node cannot inherit that descriptor.
  // A test-only shim materializes the heredoc, then executes the correctly
  // translated native Node path. The launcher still runs its real shell preamble.
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

function workspace(home, request, body) {
  const encoded = Buffer.from(JSON.stringify({ protocolVersion: 1, ...request })).toString("base64");
  const result = spawnSync(shell, [launcher, "--workspace", encoded], {
    encoding: "utf8",
    env: launcherEnv(home),
    input: body,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const lines = result.stdout.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `expected one reply line, got: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

/** The token the launcher minted for a file's current bytes. */
function hashOf(home, path) {
  const reply = workspace(home, { operation: "read", path });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.hash;
}

/**
 * Two directories, not one: the Windows node shim writes into `$HOME`, and those
 * files would otherwise show up in every listing assertion.
 */
function withScratch(callback) {
  mkdirSync(scratchRoot, { recursive: true });
  const base = mkdtempSync(join(scratchRoot, "pi-workspace-"));
  const home = join(base, "home");
  const tree = join(base, "tree");
  mkdirSync(home, { recursive: true });
  mkdirSync(tree, { recursive: true });
  try {
    return callback({ home, tree, treePath: toLauncherPath(tree) });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("the capability handshake advertises read-only workspace browsing", () => {
  withScratch(({ home }) => {
    const result = spawnSync(shell, [launcher, "--capabilities"], {
      encoding: "utf8",
      env: launcherEnv(home),
    });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout.trim());
    assert.ok(reply.capabilities.includes("workspace-v1"));
    // Reads and writes are separate names: a desktop must be able to offer browsing on
    // a host whose launcher predates hash-checked writes, and refuse editing there.
    assert.ok(reply.capabilities.includes("workspace-writes-v1"));
    // Gated by name, never inferred: the payload protocol did not move for this.
    assert.equal(reply.launcherProtocolVersion, 1);
  });
});

test("a workspace request is validated before anything is opened", () => {
  withScratch(({ home, treePath }) => {
    const cases = [
      { protocolVersion: 2, operation: "list", path: treePath },
      // Fixed operations: anything outside the list is refused, not attempted.
      { operation: "chmod", path: treePath },
      { operation: "list", path: "relative/path" },
      { operation: "list" },
      { operation: "read", path: treePath, encoding: "hex" },
      { operation: "list", path: `${treePath}/\u0007evil` },
      { operation: "list", path: `/${"x".repeat(4097)}` },
      // The hash is a token this launcher minted, so a malformed one is a caller bug
      // rather than something to compare and fail on.
      { operation: "write", path: `${treePath}/a.txt`, expectedHash: "deadbeef" },
      { operation: "write", path: `${treePath}/a.txt`, expectedHash: `sha256-${"Z".repeat(64)}` },
    ];
    for (const request of cases) {
      assert.deepEqual(
        workspace(home, request),
        { ok: false, errorCode: "workspacePayloadInvalid" },
        JSON.stringify(request),
      );
    }
  });
});

test("stat distinguishes a directory from a file and reports its size", () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "notes.md"), "hello");
    const directory = workspace(home, { operation: "stat", path: treePath });
    assert.equal(directory.ok, true, JSON.stringify(directory));
    assert.equal(directory.kind, "dir");
    assert.equal(directory.bytes, 0, "a directory has no meaningful size to report");
    const file = workspace(home, { operation: "stat", path: `${treePath}/notes.md` });
    assert.equal(file.kind, "file");
    assert.equal(file.bytes, 5);
    assert.ok(Number.isSafeInteger(file.modifiedAt) && file.modifiedAt > 0);
  });
});

test("list returns absolute, sorted entries the existing tree component can render", () => {
  withScratch(({ home, tree, treePath }) => {
    mkdirSync(join(tree, "src"));
    writeFileSync(join(tree, "b.txt"), "b");
    writeFileSync(join(tree, "a.txt"), "a");
    const reply = workspace(home, { operation: "list", path: treePath });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.truncated, false);
    // Sorted by the launcher so every host answers the same way and a tree does not
    // reshuffle between two listings of one directory.
    assert.deepEqual(reply.entries, [
      { name: "a.txt", path: `${treePath}/a.txt`, isDir: false },
      { name: "b.txt", path: `${treePath}/b.txt`, isDir: false },
      { name: "src", path: `${treePath}/src`, isDir: true },
    ]);
  });
});

test("list refuses a file and read refuses a directory", () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "notes.md"), "hello");
    assert.deepEqual(workspace(home, { operation: "list", path: `${treePath}/notes.md` }), {
      ok: false,
      errorCode: "workspaceNotADirectory",
    });
    assert.deepEqual(workspace(home, { operation: "read", path: treePath }), {
      ok: false,
      errorCode: "workspaceNotAFile",
    });
  });
});

test("read returns utf8 by default and base64 on request", () => {
  withScratch(({ home, tree, treePath }) => {
    const bytes = Buffer.from([0xff, 0x00, 0x41, 0x0a]);
    writeFileSync(join(tree, "text.txt"), "héllo\n");
    writeFileSync(join(tree, "blob.bin"), bytes);
    const text = workspace(home, { operation: "read", path: `${treePath}/text.txt` });
    assert.equal(text.ok, true, JSON.stringify(text));
    assert.equal(text.encoding, "utf8");
    assert.equal(text.content, "héllo\n");
    assert.equal(text.bytes, Buffer.byteLength("héllo\n"));
    // Base64 exists because a utf8 round trip would mangle a binary file into
    // replacement characters and report success.
    const blob = workspace(home, { operation: "read", path: `${treePath}/blob.bin`, encoding: "base64" });
    assert.equal(blob.encoding, "base64");
    assert.deepEqual(Buffer.from(blob.content, "base64"), bytes);
  });
});

test("a missing path and an oversized file each get their own code", () => {
  withScratch(({ home, tree, treePath }) => {
    assert.deepEqual(workspace(home, { operation: "stat", path: `${treePath}/absent` }), {
      ok: false,
      errorCode: "workspaceNotFound",
      detail: "ENOENT",
    });
    // The reply crosses ssh as one line, so an unbounded read would stall a channel
    // the desktop is waiting on synchronously.
    writeFileSync(join(tree, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 1));
    const reply = workspace(home, { operation: "read", path: `${treePath}/big.bin` });
    assert.equal(reply.ok, false);
    assert.equal(reply.errorCode, "workspaceTooLarge");
    assert.equal(reply.detail, String(2 * 1024 * 1024 + 1));
    // Exactly at the cap still reads.
    writeFileSync(join(tree, "edge.bin"), Buffer.alloc(2 * 1024 * 1024));
    assert.equal(workspace(home, { operation: "read", path: `${treePath}/edge.bin`, encoding: "base64" }).ok, true);
  });
});

test("a listing past the entry cap is truncated rather than returned whole", () => {
  withScratch(({ home, tree, treePath }) => {
    for (let index = 0; index <= 2_000; index += 1) {
      writeFileSync(join(tree, `f${String(index).padStart(5, "0")}.txt`), "");
    }
    const reply = workspace(home, { operation: "list", path: treePath });
    assert.equal(reply.entries.length, 2_000);
    assert.equal(reply.truncated, true);
    // Truncation keeps the sorted prefix, so paging is at least deterministic.
    assert.equal(reply.entries[0].name, "f00000.txt");
    assert.equal(reply.entries.at(-1).name, "f01999.txt");
  });
});

test("a read hands back a hash the desktop can hold as an If-Match token", () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "notes.md"), "hello");
    const reply = workspace(home, { operation: "read", path: `${treePath}/notes.md` });
    // sha256 of "hello", so the token is over the raw bytes and reproducible — but the
    // desktop never has to reproduce it, which is the point.
    assert.equal(
      reply.hash,
      "sha256-2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    // Same bytes through base64 must mint the same token, or a binary file would look
    // like a conflict against its own read.
    assert.equal(
      workspace(home, { operation: "read", path: `${treePath}/notes.md`, encoding: "base64" }).hash,
      reply.hash,
    );
  });
});

test("a write must present the hash it read, and a stale one is refused", () => {
  withScratch(({ home, tree, treePath }) => {
    const path = `${treePath}/notes.md`;
    writeFileSync(join(tree, "notes.md"), "original");
    const original = hashOf(home, path);

    const written = workspace(home, { operation: "write", path, expectedHash: original }, "updated");
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(written.bytes, 7);
    assert.equal(readFileSync(join(tree, "notes.md"), "utf8"), "updated");
    // The reply's hash is the new content's, so a caller can keep editing without a
    // re-read round trip.
    assert.equal(written.hash, hashOf(home, path));

    // Concurrency here is real: pi edits the same tree from the same host. Replaying
    // the first write is exactly what a retry after a disconnect would do.
    const stale = workspace(home, { operation: "write", path, expectedHash: original }, "clobbered");
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, "workspaceHashMismatch");
    // The live hash rides along, so the desktop can choose reload or overwrite without
    // another round trip.
    assert.equal(stale.currentHash, written.hash);
    assert.equal(readFileSync(join(tree, "notes.md"), "utf8"), "updated", "the file is untouched");
  });
});

test("expectedHash null asserts the path is free, and omitting it is refused", () => {
  withScratch(({ home, tree, treePath }) => {
    const fresh = `${treePath}/new.md`;
    // Omitted is a caller that has not decided. Defaulting for it is how a concurrent
    // create gets clobbered.
    assert.deepEqual(workspace(home, { operation: "write", path: fresh }, "body"), {
      ok: false,
      errorCode: "workspaceHashRequired",
    });

    const created = workspace(home, { operation: "write", path: fresh, expectedHash: null }, "body");
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(readFileSync(join(tree, "new.md"), "utf8"), "body");

    // The same assertion now false: something exists, so this is a conflict rather than
    // a create.
    const again = workspace(home, { operation: "write", path: fresh, expectedHash: null }, "second");
    assert.equal(again.errorCode, "workspaceHashMismatch");
    assert.equal(again.currentHash, created.hash);
    assert.equal(readFileSync(join(tree, "new.md"), "utf8"), "body");
  });
});

test("a write is atomic and preserves the file's mode", { skip: !posix }, () => {
  withScratch(({ home, tree, treePath }) => {
    const path = `${treePath}/script.sh`;
    writeFileSync(join(tree, "script.sh"), "#!/bin/sh\n", { mode: 0o750 });
    const reply = workspace(home, { operation: "write", path, expectedHash: hashOf(home, path) }, "#!/bin/sh\necho hi\n");
    assert.equal(reply.ok, true, JSON.stringify(reply));
    // temp+rename would otherwise silently demote an executable to 0644.
    assert.equal(statSync(join(tree, "script.sh")).mode & 0o777, 0o750);
    // No temp file survives a successful write.
    assert.deepEqual(readdirSync(tree), ["script.sh"]);
  });
});

test("create refuses to clobber and mkdir is idempotent", () => {
  withScratch(({ home, tree, treePath }) => {
    const created = workspace(home, { operation: "create", path: `${treePath}/fresh.txt` });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.bytes, 0);
    // sha256 of the empty string, so an empty new file already has a usable token.
    assert.equal(
      created.hash,
      "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.equal(workspace(home, { operation: "create", path: `${treePath}/fresh.txt` }).errorCode,
      "workspaceExists");

    const made = workspace(home, { operation: "mkdir", path: `${treePath}/a/b` });
    assert.equal(made.created, true);
    // Recursive, matching the local bridge: one round trip per path segment would be
    // the alternative.
    assert.equal(workspace(home, { operation: "list", path: `${treePath}/a` }).entries[0].name, "b");
    // Already-a-directory is success, not a conflict — the desired state holds.
    assert.deepEqual(workspace(home, { operation: "mkdir", path: `${treePath}/a/b` }), {
      ok: true, operation: "mkdir", path: `${treePath}/a/b`, created: false,
    });
    assert.equal(workspace(home, { operation: "mkdir", path: `${treePath}/fresh.txt` }).errorCode,
      "workspaceExists");
  });
});

test("delete needs a matching hash for a file and an empty directory", () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "doomed.txt"), "bye");
    const path = `${treePath}/doomed.txt`;
    const hash = hashOf(home, path);
    assert.equal(workspace(home, { operation: "delete", path }).errorCode, "workspaceHashRequired");
    assert.equal(
      workspace(home, { operation: "delete", path, expectedHash: `sha256-${"0".repeat(64)}` }).errorCode,
      "workspaceHashMismatch",
    );
    assert.equal(workspace(home, { operation: "delete", path, expectedHash: hash }).ok, true);
    assert.equal(workspace(home, { operation: "stat", path }).errorCode, "workspaceNotFound");

    mkdirSync(join(tree, "full", "inner"), { recursive: true });
    // The local bridge deletes a tree recursively; this deliberately does not. An
    // irreversible recursive delete on a machine nobody is looking at needs a
    // confirmation flow that does not exist yet.
    const refused = workspace(home, { operation: "delete", path: `${treePath}/full` });
    assert.equal(refused.errorCode, "workspaceDirectoryNotEmpty");
    assert.equal(refused.detail, "1");
    assert.equal(workspace(home, { operation: "delete", path: `${treePath}/full/inner` }).kind, "dir");
    assert.equal(workspace(home, { operation: "delete", path: `${treePath}/full` }).ok, true);
  });
});

test("rename refuses an occupied destination instead of overwriting it", () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "from.txt"), "content");
    writeFileSync(join(tree, "occupied.txt"), "do not lose me");
    // POSIX rename would silently replace this — a lost file with no record it existed.
    const refused = workspace(home, {
      operation: "rename", path: `${treePath}/from.txt`, to: `${treePath}/occupied.txt`,
    });
    assert.equal(refused.errorCode, "workspaceExists");
    assert.equal(readFileSync(join(tree, "occupied.txt"), "utf8"), "do not lose me");

    const moved = workspace(home, {
      operation: "rename", path: `${treePath}/from.txt`, to: `${treePath}/to.txt`,
    });
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.equal(readFileSync(join(tree, "to.txt"), "utf8"), "content");
    assert.equal(
      workspace(home, { operation: "rename", path: `${treePath}/absent`, to: `${treePath}/x` }).errorCode,
      "workspaceNotFound",
    );
    // `to` belongs to rename and nothing else, so a stray one is a caller bug.
    assert.equal(
      workspace(home, { operation: "read", path: `${treePath}/to.txt`, to: `${treePath}/x` }).errorCode,
      "workspacePayloadInvalid",
    );
    assert.equal(
      workspace(home, { operation: "rename", path: `${treePath}/to.txt`, to: "relative" }).errorCode,
      "workspacePayloadInvalid",
    );
  });
});

test("a write body can arrive base64-encoded for binary content", () => {
  withScratch(({ home, tree, treePath }) => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x0a]);
    const path = `${treePath}/blob.bin`;
    const reply = workspace(
      home,
      { operation: "write", path, expectedHash: null, encoding: "base64" },
      bytes.toString("base64"),
    );
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(readFileSync(join(tree, "blob.bin")), bytes);
    // The token is over the stored bytes, so a read of what was just written agrees.
    assert.equal(reply.hash, hashOf(home, path));
  });
});

test("every write operation refuses a symlink rather than following it", { skip: !posix }, () => {
  withScratch(({ home, tree, treePath }) => {
    writeFileSync(join(tree, "real.txt"), "outside");
    symlinkSync(join(tree, "real.txt"), join(tree, "linked.txt"));
    const path = `${treePath}/linked.txt`;
    const cases = [
      { operation: "write", path, expectedHash: null },
      { operation: "delete", path, expectedHash: `sha256-${"0".repeat(64)}` },
      { operation: "rename", path, to: `${treePath}/moved.txt` },
      { operation: "mkdir", path },
    ];
    for (const request of cases) {
      const reply = workspace(home, request, "body");
      assert.equal(reply.errorCode, "workspaceSymlinkRejected", JSON.stringify(request));
    }
    // A rename *into* a link's path is refused too, or the write would land outside.
    symlinkSync(join(tree, "real.txt"), join(tree, "link2.txt"));
    writeFileSync(join(tree, "source.txt"), "x");
    assert.equal(
      workspace(home, { operation: "rename", path: `${treePath}/source.txt`, to: `${treePath}/link2.txt` }).errorCode,
      "workspaceSymlinkRejected",
    );
    assert.equal(readFileSync(join(tree, "real.txt"), "utf8"), "outside");
  });
});

test("a symlink is refused for reading and listed as a leaf", { skip: !posix }, () => {
  withScratch(({ home, tree, treePath }) => {
    mkdirSync(join(tree, "real"));
    writeFileSync(join(tree, "real", "secret.txt"), "outside");
    symlinkSync(join(tree, "real"), join(tree, "linked-dir"), "dir");
    symlinkSync(join(tree, "real", "secret.txt"), join(tree, "linked-file"));

    for (const target of ["linked-dir", "linked-file"]) {
      assert.deepEqual(workspace(home, { operation: "stat", path: `${treePath}/${target}` }), {
        ok: false,
        errorCode: "workspaceSymlinkRejected",
      }, target);
    }
    assert.equal(workspace(home, { operation: "read", path: `${treePath}/linked-file` }).errorCode,
      "workspaceSymlinkRejected");
    assert.equal(workspace(home, { operation: "list", path: `${treePath}/linked-dir` }).errorCode,
      "workspaceSymlinkRejected");

    // Still visible in the parent listing, but as a leaf: presenting it as a
    // directory would be a lie the tree acts on by trying to descend it.
    const entries = workspace(home, { operation: "list", path: treePath }).entries;
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.isDir]),
      [["linked-dir", false], ["linked-file", false], ["real", true]],
    );
  });
});
