import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopRemoteWorkspaceFsPort,
  profileIdFromTargetId,
  RemoteWorkspaceError,
} from "../../src/lib/backend/desktop/remote-workspace-fs";
import {
  createUnsupportedRemoteWorkspaceFsPort,
  isRemoteWorkspaceConflict,
  isRemoteWorkspaceLauncherOutdated,
  isRemoteWorkspaceUnsupported,
  RemoteWorkspaceConflictError,
  supportsHashedWrites,
} from "../../src/lib/backend/ports/remote-workspace-fs";

type Call = { command: string; args?: Record<string, unknown> };

function harness(reply: unknown | ((call: Call) => unknown)) {
  const calls: Call[] = [];
  const port = createDesktopRemoteWorkspaceFsPort("ssh:remote-7f3a", {
    invoke: async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
      const call = { command, args };
      calls.push(call);
      return (typeof reply === "function" ? (reply as (c: Call) => unknown)(call) : reply) as T;
    },
  });
  return { port, calls };
}

test("a remote target id resolves to the profile the request is scoped to", () => {
  assert.equal(profileIdFromTargetId("ssh:remote-7f3a"), "remote-7f3a");
  // Anything else is a programming error: ids are produced by one function.
  for (const bad of ["local", "ssh:", "remote-7f3a", ""]) {
    assert.throws(() => profileIdFromTargetId(bad), (error) => isRemoteWorkspaceUnsupported(error));
  }
});

test("listDir asks the launcher for a listing and keeps only well-formed entries", async () => {
  const { port, calls } = harness({
    ok: true,
    operation: "list",
    path: "/srv/project",
    truncated: false,
    entries: [
      { name: "src", path: "/srv/project/src", isDir: true },
      { name: "a.txt", path: "/srv/project/a.txt", isDir: false },
      // A launcher that answered with something malformed must not become a
      // half-built entry the tree then renders.
      { name: "broken" },
    ],
  });
  const entries = await port.listDir("/srv/project");
  assert.deepEqual(entries, [
    { name: "src", path: "/srv/project/src", isDir: true },
    { name: "a.txt", path: "/srv/project/a.txt", isDir: false },
  ]);
  assert.deepEqual(calls, [
    {
      command: "remote_workspace_request",
      args: { id: "remote-7f3a", operation: "list", path: "/srv/project" },
    },
  ]);
});

test("reads ask for the encoding they need", async () => {
  const { port, calls } = harness((call: Call) => ({
    ok: true,
    operation: "read",
    path: call.args?.path,
    encoding: call.args?.encoding,
    content: call.args?.encoding === "base64" ? "AAEC" : "hello",
    bytes: 5,
  }));
  assert.equal(await port.readFile("/srv/project/a.txt"), "hello");
  // Base64 exists because a utf8 round trip would mangle a binary file into
  // replacement characters and report success.
  assert.equal(await port.readFileBase64("/srv/project/logo.png"), "AAEC");
  assert.deepEqual(calls.map((call) => call.args?.encoding), ["utf8", "base64"]);
});

test("a launcher error code is surfaced verbatim, not flattened into prose", async () => {
  const { port } = harness({ ok: false, errorCode: "workspaceSymlinkRejected" });
  await assert.rejects(
    () => port.listDir("/srv/project/linked"),
    (error: unknown) => {
      assert.ok(error instanceof RemoteWorkspaceError);
      // The UI has to tell "this target cannot browse" from "this path is a link"
      // without string-matching a message.
      assert.equal(error.code, "workspaceSymlinkRejected");
      assert.equal(error.path, "/srv/project/linked");
      return true;
    },
  );
});

test("a reply that is not the expected shape is rejected rather than trusted", async () => {
  for (const reply of [null, "text", { ok: true, operation: "read" }, { ok: true }]) {
    const { port } = harness(reply);
    await assert.rejects(() => port.readFile("/srv/project/a.txt"));
  }
  const { port } = harness({ ok: true, operation: "read", content: "x" });
  // Right shape for a read, wrong operation for a listing.
  await assert.rejects(() => port.listDir("/srv/project"));
});

test("the hashless mutators stay refused even now that writes exist", async () => {
  const { port, calls } = harness({ ok: true });
  const mutations: Array<[string, () => Promise<unknown>]> = [
    ["root", () => port.root()],
    ["writeFile", () => port.writeFile("/srv/project/a.txt", "x")],
    ["createFile", () => port.createFile("/srv/project/b.txt")],
    ["createDir", () => port.createDir("/srv/project/dir")],
    ["deleteEntry", () => port.deleteEntry("/srv/project/a.txt")],
    ["renameEntry", () => port.renameEntry("/srv/project/a.txt", "/srv/project/b.txt")],
  ];
  for (const [name, call] of mutations) {
    await assert.rejects(call, (error) => isRemoteWorkspaceUnsupported(error), name);
  }
  // A blind remote write is exactly the lost update V2.4 exists to prevent, so a
  // caller with no hash is turned away locally rather than given a best-effort.
  assert.deepEqual(calls, []);
});

test("the port advertises hashed writes and the refusing stub does not", () => {
  const { port } = harness({ ok: true });
  assert.equal(supportsHashedWrites(port), true);
  // The store uses this to decide whether editing is offered at all, so a
  // read-only target must answer false rather than throw on first write.
  assert.equal(supportsHashedWrites(createUnsupportedRemoteWorkspaceFsPort("ssh:old-host")), false);
  assert.equal(supportsHashedWrites(null), false);
});

test("a hashed read carries the token a later write has to present", async () => {
  const { port, calls } = harness({
    ok: true,
    operation: "read",
    path: "/srv/project/a.txt",
    encoding: "utf8",
    content: "hello",
    bytes: 5,
    hash: `sha256-${"a".repeat(64)}`,
  });
  assert.deepEqual(await port.readFileHashed("/srv/project/a.txt"), {
    content: "hello",
    hash: `sha256-${"a".repeat(64)}`,
  });
  assert.equal(calls[0].args?.encoding, "utf8");
  // The token is opaque: nothing here recomputes it, which is what keeps a lossy
  // utf8 round trip from turning into a phantom conflict.
  assert.equal(calls[0].args?.expectedHash, undefined);
});

test("a hashed write sends the content as a body and the token as If-Match", async () => {
  const { port, calls } = harness({
    ok: true,
    operation: "write",
    path: "/srv/project/a.txt",
    bytes: 7,
    hash: `sha256-${"b".repeat(64)}`,
  });
  const result = await port.writeFileHashed("/srv/project/a.txt", "updated", `sha256-${"a".repeat(64)}`);
  assert.deepEqual(result, { hash: `sha256-${"b".repeat(64)}`, bytes: 7 });
  assert.deepEqual(calls[0].args, {
    id: "remote-7f3a",
    operation: "write",
    path: "/srv/project/a.txt",
    encoding: "utf8",
    expectedHash: `sha256-${"a".repeat(64)}`,
    body: "updated",
  });
});

test("an explicit null hash is sent, and a directory delete omits the key entirely", async () => {
  const { port, calls } = harness((call: Call) =>
    call.args?.operation === "delete"
      ? { ok: true, operation: "delete", path: call.args.path, kind: "dir" }
      : { ok: true, operation: "write", path: call.args?.path, bytes: 4, hash: `sha256-${"c".repeat(64)}` },
  );
  // null is an assertion — "I believe this path is free" — so it has to reach the
  // launcher. Omitting it there means the caller has not decided, which is refused.
  await port.writeFileHashed("/srv/project/new.txt", "body", null);
  assert.equal(calls[0].args?.expectedHash, null);
  assert.ok("expectedHash" in (calls[0].args ?? {}));

  // A directory has no hash at all, and the launcher rejects one on a directory.
  await port.deleteEntryHashed("/srv/project/dir", null);
  assert.equal("expectedHash" in (calls[1].args ?? {}), false);
});

test("a lost update is its own error type, carrying the live hash", async () => {
  const { port } = harness({
    ok: false,
    errorCode: "workspaceHashMismatch",
    currentHash: `sha256-${"d".repeat(64)}`,
  });
  await assert.rejects(
    () => port.writeFileHashed("/srv/project/a.txt", "mine", `sha256-${"a".repeat(64)}`),
    (error: unknown) => {
      assert.ok(isRemoteWorkspaceConflict(error));
      assert.ok(error instanceof RemoteWorkspaceConflictError);
      // Every other failure means "it did not work"; this one means "someone else got
      // there first, and here is what they wrote" — so the UI can offer reload vs.
      // overwrite without another round trip.
      assert.equal(error.currentHash, `sha256-${"d".repeat(64)}`);
      assert.equal(error.path, "/srv/project/a.txt");
      return true;
    },
  );
  // A conflict on a path that no longer exists reports null rather than inventing one.
  const gone = harness({ ok: false, errorCode: "workspaceHashMismatch" });
  await assert.rejects(
    () => gone.port.writeFileHashed("/srv/project/a.txt", "mine", null),
    (error: unknown) => isRemoteWorkspaceConflict(error) && error.currentHash === null,
  );
});

test("a launcher too old for --workspace is reported as a reinstall, not a transport fault", async () => {
  // A host enrolled before V2 rejects the mode in the launcher's shell preamble and
  // never reaches the JSON reply path, so this arrives as a rejected invoke carrying
  // the backend's `<errorCode>: <message>` string. Left untranslated it reads as a
  // broken connection, and the user debugs SSH instead of pressing Install.
  const outdated = createDesktopRemoteWorkspaceFsPort("ssh:remote-7f3a", {
    invoke: async () => {
      throw new Error("launcher_mode_unsupported: invalid launcher mode");
    },
  });
  await assert.rejects(
    () => outdated.listDir("/srv/project"),
    (error: unknown) => {
      assert.ok(isRemoteWorkspaceLauncherOutdated(error));
      // Not the "this build cannot" signal: that one has no user-side fix.
      assert.ok(!isRemoteWorkspaceUnsupported(error));
      return true;
    },
  );

  // Every other transport failure must pass through untouched — claiming a reinstall
  // fixes a dead host would send the user to the one button that cannot help.
  for (const message of [
    "ssh_auth_failed: Permission denied (publickey).",
    "ssh_unreachable: connect to host prod port 22: Connection refused",
    // The code has to be the prefix, not merely present: a remote banner or a path
    // that quotes it is not the launcher's mode dispatch.
    "ssh_failed: cat: launcher_mode_unsupported: No such file",
  ]) {
    const other = createDesktopRemoteWorkspaceFsPort("ssh:remote-7f3a", {
      invoke: async () => {
        throw new Error(message);
      },
    });
    await assert.rejects(
      () => other.listDir("/srv/project"),
      (error: unknown) =>
        !isRemoteWorkspaceLauncherOutdated(error) &&
        error instanceof Error &&
        error.message === message,
    );
  }
});

test("a write reply without a usable hash is rejected rather than assumed", async () => {
  for (const reply of [
    { ok: true, operation: "write", path: "/srv/project/a.txt", bytes: 4 },
    { ok: true, operation: "write", path: "/srv/project/a.txt", hash: "sha256-x" },
  ]) {
    const { port } = harness(reply);
    // Returning a wrong token would make the *next* write look like a conflict, so a
    // missing one has to fail here rather than be papered over.
    await assert.rejects(() => port.writeFileHashed("/srv/project/a.txt", "x", null));
  }
});
