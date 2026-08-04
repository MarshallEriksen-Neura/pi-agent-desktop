import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("BackendProvider gates descendants behind explicit desktop/browser composition", () => {
  const provider = fs.readFileSync(
    path.join(process.cwd(), "src/components/BackendProvider.tsx"),
    "utf8",
  );
  const layout = fs.readFileSync(
    path.join(process.cwd(), "src/app/layout.tsx"),
    "utf8",
  );

  assert.match(provider, /status !== "ready"/);
  assert.match(provider, /data-testid="backend-bootstrap"/);
  assert.match(provider, /composition\/desktop/);
  assert.match(provider, /composition\/browser/);
  assert.match(provider, /getBackendKind\(\) === "unconfigured"/);
  assert.ok(layout.indexOf("<BackendProvider>") < layout.indexOf("<AppShell>"));
  assert.ok(layout.indexOf("</AppShell>") < layout.indexOf("</BackendProvider>"));
});
