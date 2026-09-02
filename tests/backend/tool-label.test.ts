import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { EDIT_TOOL, toolKind } from "../../src/lib/pi/tool-label";

/**
 * The three mutating tools `pi-hashline-edit-pro` registers. `replace` was
 * classified from the start; `insert` and `undo_last_change` were not, so their
 * calls drew the generic wrench and — the part that actually mattered — never
 * entered agent-bridge's edit branch: no pre-edit snapshot, no read-back, no
 * recorded FileDiff. The turn panel then reported no file changes for an edit
 * `git diff` could see.
 */
const HASHLINE_MUTATORS = ["replace", "insert", "undo_last_change"];

/**
 * Spellings other vendors' editors use. Kept working so swapping editor
 * extensions cannot silently switch the diff pipeline off.
 */
const OTHER_EDITORS = [
  "edit",
  "write",
  "multi_edit",
  "multiEdit",
  "str_replace",
  "str_replace_editor",
  "create_file",
  "apply_patch",
];

/**
 * Every other tool name observed in this machine's pi transcripts. None of them
 * writes a file, so none may be admitted to the edit pipeline — the guard that
 * keeps EDIT_TOOL's broadened alternatives from swallowing a neighbour.
 */
const NON_EDITING = [
  "read",
  "bash",
  "grep",
  "ffgrep",
  "fffind",
  "find",
  "ls",
  "todo",
  "subagent",
  "subagent_wait",
  "subagent_supervisor",
  "subagent_manage",
  "anchor_grep",
  "agent_browser",
  "ask_user_question",
  "contact_supervisor",
  "lsp_diagnostics",
  "goal_complete",
  "add_directory",
  "plan_mode_complete",
  "mcpScript",
  "mcp",
];

test("every hash-line mutating tool classifies as a write", () => {
  for (const name of HASHLINE_MUTATORS) {
    assert.equal(toolKind(name), "write", `${name} must classify as an edit tool`);
  }
});

test("other editors' spellings keep classifying as writes", () => {
  for (const name of OTHER_EDITORS) {
    assert.equal(toolKind(name), "write", `${name} must classify as an edit tool`);
  }
});

test("names are matched whole, and case- and separator-insensitively", () => {
  assert.equal(toolKind("Insert"), "write");
  assert.equal(toolKind("UNDO-LAST-CHANGE"), "write");
  // …while a longer name that merely contains one belongs to a different tool
  assert.equal(EDIT_TOOL.test("insert_snippet"), false);
  assert.equal(EDIT_TOOL.test("db_insert"), false);
});

test("nothing that only reads or searches is admitted as a write", () => {
  for (const name of NON_EDITING) {
    assert.notEqual(toolKind(name), "write", `${name} must not classify as an edit tool`);
  }
});

test("the bridge admits an edit to the diff pipeline only through EDIT_TOOL", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/lib/pi/agent-bridge.ts"),
    "utf8",
  );

  const gate = source.indexOf("if (EDIT_TOOL.test(e.toolName))");
  const snapshot = source.indexOf("rec.snapshot = (async () =>", gate + 1);
  const bashBranch = source.indexOf("} else if (BASH_TOOL.test(e.toolName))", gate + 1);
  assert.ok(gate >= 0, "the edit branch must stay gated on EDIT_TOOL");
  assert.ok(bashBranch > gate, "the bash branch must remain that gate's alternative");
  assert.ok(
    snapshot > gate && snapshot < bashBranch,
    "the pre-edit snapshot must live inside the EDIT_TOOL gate",
  );

  /* …and the recorded FileDiff — the only thing turn.ts sums — hangs off the
     `kind === "edit"` that this gate is the sole writer of. Classification is
     therefore the entire admission test: an unlisted name loses the diff, not
     just the icon, which is why the lists above are asserted name by name. */
  const editEnd = source.indexOf('if (rec.kind === "edit" && rec.path && !e.isError)');
  const recordDiff = source.indexOf("useFileDiffs.getState().record(", editEnd + 1);
  assert.ok(editEnd >= 0, "the end handler must stay gated on the edit kind");
  assert.ok(recordDiff > editEnd, "the FileDiff must be recorded inside that branch");
  assert.equal(
    source.indexOf('rec.kind = "edit"'),
    source.lastIndexOf('rec.kind = "edit"'),
    "only the EDIT_TOOL gate may mark a call as an edit",
  );
});
