import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const trashDialog = fs.readFileSync(
  path.join(repoRoot, "src/components/SessionTrashDialog.tsx"),
  "utf8",
);
const confirmDialog = fs.readFileSync(
  path.join(repoRoot, "src/components/ConfirmDialog.tsx"),
  "utf8",
);
const modalFocus = fs.readFileSync(
  path.join(repoRoot, "src/hooks/useModalFocus.ts"),
  "utf8",
);

test("trash and confirmation dialogs use the shared modal keyboard contract", () => {
  assert.match(trashDialog, /useModalFocus<HTMLDivElement>/);
  assert.match(trashDialog, /paused: nestedDialogOpen/);
  assert.match(trashDialog, /initialFocusRef: closeButtonRef/);
  assert.match(trashDialog, /aria-labelledby=\{titleId\}/);
  assert.match(trashDialog, /aria-describedby=\{subtitleId\}/);

  assert.match(confirmDialog, /useModalFocus<HTMLDivElement>/);
  assert.match(confirmDialog, /initialFocusRef: cancelButtonRef/);
  assert.match(confirmDialog, /role="alertdialog"/);
});

test("modal keyboard contract traps Tab, handles Escape, and restores focus", () => {
  assert.match(modalFocus, /latestPausedRef\.current = paused/);
  assert.match(modalFocus, /if \(latestPausedRef\.current\) return/);
  assert.match(modalFocus, /event\.key === "Escape"/);
  assert.match(modalFocus, /event\.key !== "Tab"/);
  assert.match(modalFocus, /last\.focus\(\)/);
  assert.match(modalFocus, /first\.focus\(\)/);
  assert.match(modalFocus, /previous\?\.isConnected/);
  assert.match(modalFocus, /previous\.focus\(\)/);
});
