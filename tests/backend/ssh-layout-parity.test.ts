import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("SSH targets use the same editor and chat layout predicates as local targets", () => {
  const page = source("src/app/page.tsx");

  assert.ok(
    page.includes(
      "const showAgent = layoutReady && !zenMode && (workMode || agentPanelOpen);",
    ),
    "the SSH target must not force the agent panel open in editor mode",
  );
  assert.match(
    page,
    /\{showAgent\s*&&\s*\(workMode\s*\?\s*\(/,
    "work-mode chrome must follow the layout state rather than the execution target",
  );
  assert.ok(!page.includes("workMode || remoteMode"));
  assert.ok(!page.includes("effectiveWorkMode"));
  assert.ok(
    !page.includes("useUI.setState({ zenMode: false })"),
    "switching to SSH must not reset a target-independent layout mode",
  );
});

test("SSH targets keep the global work and zen keyboard commands", () => {
  const page = source("src/app/page.tsx");
  const actionsStart = page.indexOf("const actions: Record<string, () => void> = {");
  const actionsEnd = page.indexOf("};", actionsStart);
  const actions = page.slice(actionsStart, actionsEnd);

  assert.ok(actionsStart >= 0 && actionsEnd > actionsStart);
  assert.ok(actions.includes("zenMode: () => toggleZen()"));
  assert.ok(actions.includes("workMode: () => toggleWork()"));
  assert.ok(!actions.includes("remoteMode"));
});

test("the top bar exposes editor layout controls for SSH targets", () => {
  const topBar = source("src/components/TopBar.tsx");

  assert.ok(
    topBar.includes('const showWorkToggle = layoutMode !== "work-only";'),
    "only work-only may suppress the work-mode toggle",
  );
  assert.ok(topBar.includes('label={t("topbar.zenMode")}'));
  assert.ok(topBar.includes('label={t("topbar.toggleAgentPanel")}'));
  assert.ok(topBar.includes("onClick={() => setCommandPalette(true)}"));
  assert.ok(
    !topBar.includes("remoteMode"),
    "layout chrome must not branch on the execution target",
  );
});

test("the command palette hides work mode only in work-only layout", () => {
  const palette = source("src/components/CommandPalette.tsx");
  const hiddenStart = palette.indexOf("const hiddenBaseCommands");
  const hiddenEnd = palette.indexOf("const visibleBase", hiddenStart);
  const hiddenCommands = palette.slice(hiddenStart, hiddenEnd);

  assert.ok(hiddenStart >= 0 && hiddenEnd > hiddenStart);
  assert.ok(hiddenCommands.includes('layoutMode === "work-only" ? ["work"] : []'));
  assert.ok(!hiddenCommands.includes("remoteMode"));
  assert.ok(!hiddenCommands.includes('"zen"'));
});
