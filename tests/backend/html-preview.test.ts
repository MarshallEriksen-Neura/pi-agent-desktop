import assert from "node:assert/strict";
import test from "node:test";
import { htmlEditTarget } from "../../src/lib/pi/html-preview";

test("detects html targets across the edit tool surface", () => {
  assert.equal(htmlEditTarget("write", { path: "preview/index.html" }), "preview/index.html");
  assert.equal(htmlEditTarget("replace", { path: "D:/site/demo.htm" }), "D:/site/demo.htm");
  assert.equal(htmlEditTarget("edit", { file_path: "page.HTML" }), "page.HTML");
});

test("rejects non-edit tools and non-html paths", () => {
  assert.equal(htmlEditTarget("read", { path: "index.html" }), undefined);
  assert.equal(htmlEditTarget("bash", { command: "cat index.html" }), undefined);
  assert.equal(htmlEditTarget("write", { path: "src/app.tsx" }), undefined);
  assert.equal(htmlEditTarget("write", {}), undefined);
  assert.equal(htmlEditTarget("write", undefined), undefined);
});

test("normalizes relative and backslash paths against the workspace root", () => {
  assert.equal(
    htmlEditTarget("write", { path: "a\\b\\page.html" }),
    "a/b/page.html",
  );
});
