import assert from "node:assert/strict";
import test from "node:test";

import { RemoteWorkspaceConflictError } from "../../src/lib/backend/ports/remote-workspace-fs";
import type {
  HashedWorkspaceFsPort,
  HashedWriteResult,
} from "../../src/lib/backend/ports/remote-workspace-fs";
import type { FsEntryDto, WorkspaceFsPort } from "../../src/lib/backend/ports/workspace-fs";

/**
 * The store's conflict handling, exercised against a port that behaves like the
 * launcher: a write must present the token the read handed out, and a stale one is
 * refused with the live token attached.
 *
 * Driving the real store would pull in the whole zustand/UI graph, so this covers the
 * decision logic the store implements — which token is sent, and what each of the two
 * resolutions does — against the same contract.
 */

interface FakeHost {
  port: WorkspaceFsPort & HashedWorkspaceFsPort;
  /** Simulates pi editing the same file from the other side. */
  editExternally(path: string, content: string): void;
  contentOf(path: string): string | undefined;
}

function fakeHost(initial: Record<string, string> = {}): FakeHost {
  const files = new Map(Object.entries(initial));
  let counter = 0;
  const hashes = new Map<string, string>();
  const rehash = (path: string) => {
    counter += 1;
    const hash = `sha256-${String(counter).padStart(64, "0")}`;
    hashes.set(path, hash);
    return hash;
  };
  for (const path of files.keys()) rehash(path);

  const refuse = (): never => {
    throw new Error("hashless mutation");
  };
  const port = {
    root: async (): Promise<string> => refuse(),
    listDir: async (): Promise<FsEntryDto[]> => [],
    readFile: async (path: string) => files.get(path) ?? refuse(),
    readFileBase64: async (): Promise<string> => refuse(),
    writeFile: refuse,
    createFile: refuse,
    createDir: refuse,
    deleteEntry: refuse,
    renameEntry: refuse,
    readFileHashed: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`missing ${path}`);
      return { content, hash: hashes.get(path)! };
    },
    writeFileHashed: async (
      path: string,
      content: string,
      expectedHash: string | null,
    ): Promise<HashedWriteResult> => {
      const current = files.has(path) ? hashes.get(path)! : null;
      if (expectedHash !== current) {
        throw new RemoteWorkspaceConflictError(path, current);
      }
      files.set(path, content);
      return { hash: rehash(path), bytes: content.length };
    },
    createFileHashed: async (): Promise<HashedWriteResult> => refuse(),
    createDirHashed: async (): Promise<void> => refuse(),
    deleteEntryHashed: async (): Promise<void> => refuse(),
    renameEntryHashed: async (): Promise<void> => refuse(),
  } as WorkspaceFsPort & HashedWorkspaceFsPort;

  return {
    port,
    editExternally: (path, content) => {
      files.set(path, content);
      rehash(path);
    },
    contentOf: (path) => files.get(path),
  };
}

test("a write presents the token from its read and is accepted", async () => {
  const host = fakeHost({ "/srv/a.txt": "original" });
  const opened = await host.port.readFileHashed("/srv/a.txt");
  const written = await host.port.writeFileHashed("/srv/a.txt", "mine", opened.hash);
  assert.equal(host.contentOf("/srv/a.txt"), "mine");
  // The reply's token lets an editor keep saving without re-reading between saves.
  const again = await host.port.writeFileHashed("/srv/a.txt", "mine again", written.hash);
  assert.equal(host.contentOf("/srv/a.txt"), "mine again");
  assert.notEqual(again.hash, written.hash);
});

test("pi editing underneath turns the next save into a conflict, not a clobber", async () => {
  const host = fakeHost({ "/srv/a.txt": "original" });
  const opened = await host.port.readFileHashed("/srv/a.txt");
  host.editExternally("/srv/a.txt", "pi wrote this");

  await assert.rejects(
    () => host.port.writeFileHashed("/srv/a.txt", "mine", opened.hash),
    (error: unknown) => {
      assert.ok(error instanceof RemoteWorkspaceConflictError);
      // The live token rides along so a resolution needs no extra round trip.
      assert.notEqual(error.currentHash, opened.hash);
      return true;
    },
  );
  assert.equal(host.contentOf("/srv/a.txt"), "pi wrote this", "the host copy is untouched");
});

test("take-theirs re-reads, and keep-mine writes against the hash from the conflict", async () => {
  const host = fakeHost({ "/srv/a.txt": "original" });
  const opened = await host.port.readFileHashed("/srv/a.txt");
  host.editExternally("/srv/a.txt", "pi wrote this");
  const conflict = await host.port
    .writeFileHashed("/srv/a.txt", "mine", opened.hash)
    .then(() => null, (error: RemoteWorkspaceConflictError) => error);
  assert.ok(conflict);

  // Take theirs: the fresh read yields both the new content and a usable token.
  const reread = await host.port.readFileHashed("/srv/a.txt");
  assert.equal(reread.content, "pi wrote this");
  assert.equal(reread.hash, conflict.currentHash);

  // Keep mine: a second write against the *current* hash, not a force flag — so if the
  // file moved again in between, it is refused again rather than overwriting a change
  // nobody has seen.
  await host.port.writeFileHashed("/srv/a.txt", "mine", conflict.currentHash);
  assert.equal(host.contentOf("/srv/a.txt"), "mine");
});

test("keep-mine is refused again when the file moved a second time", async () => {
  const host = fakeHost({ "/srv/a.txt": "original" });
  const opened = await host.port.readFileHashed("/srv/a.txt");
  host.editExternally("/srv/a.txt", "first外部");
  const conflict = await host.port
    .writeFileHashed("/srv/a.txt", "mine", opened.hash)
    .then(() => null, (error: RemoteWorkspaceConflictError) => error);
  assert.ok(conflict);

  // A third party writes between the conflict and the user's choice.
  host.editExternally("/srv/a.txt", "second外部");
  await assert.rejects(
    () => host.port.writeFileHashed("/srv/a.txt", "mine", conflict.currentHash),
    (error: unknown) => error instanceof RemoteWorkspaceConflictError,
  );
  assert.equal(host.contentOf("/srv/a.txt"), "second外部");
});

test("a new file asserts absence with null, and losing that race is a conflict", async () => {
  const host = fakeHost();
  await host.port.writeFileHashed("/srv/new.txt", "first", null);
  assert.equal(host.contentOf("/srv/new.txt"), "first");
  // Someone else created it first: `null` no longer holds, so this is a conflict rather
  // than an overwrite.
  await assert.rejects(
    () => host.port.writeFileHashed("/srv/new.txt", "second", null),
    (error: unknown) => error instanceof RemoteWorkspaceConflictError,
  );
  assert.equal(host.contentOf("/srv/new.txt"), "first");
});
