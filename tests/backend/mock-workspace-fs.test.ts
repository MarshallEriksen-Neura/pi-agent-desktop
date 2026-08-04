import assert from "node:assert/strict";
import test from "node:test";

import { createMockWorkspaceFsPort } from "../../src/lib/backend/mock/workspace-fs";

test("mock workspace listing uses injected and mutated file state", async () => {
  const fs = createMockWorkspaceFsPort({
    "src/a.ts": "a",
    "README.md": "readme",
  });

  assert.deepEqual(await fs.listDir(""), [
    { name: "src", path: "src", isDir: true },
    { name: "README.md", path: "README.md", isDir: false },
  ]);

  await fs.createFile("src/b.ts");
  assert.deepEqual(await fs.listDir("src"), [
    { name: "a.ts", path: "src/a.ts", isDir: false },
    { name: "b.ts", path: "src/b.ts", isDir: false },
  ]);

  await fs.renameEntry("src", "app");
  assert.deepEqual(await fs.listDir("app"), [
    { name: "a.ts", path: "app/a.ts", isDir: false },
    { name: "b.ts", path: "app/b.ts", isDir: false },
  ]);
  await fs.deleteEntry("app/a.ts");
  assert.deepEqual(await fs.listDir("app"), [
    { name: "b.ts", path: "app/b.ts", isDir: false },
  ]);
});
