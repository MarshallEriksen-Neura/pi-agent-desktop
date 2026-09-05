import assert from "node:assert/strict";
import test from "node:test";

import type { ExecutionBinding } from "../../src/lib/backend/ports/execution-target";
import {
  closeTerminalTab,
  createLocalTerminalTab,
  createSshTerminalTab,
  LOCAL_TERMINAL_TAB_ID,
  MAX_TERMINAL_TABS,
  renameTerminalTab,
  sshTerminalBindingKey,
  syncTerminalTabsToBinding,
  type TerminalTabsState,
} from "../../src/lib/terminal-tabs";

function remoteBinding(hostAlias: string, remoteCwd = "/srv/app"): Extract<ExecutionBinding, { kind: "ssh" }> {
  return {
    kind: "ssh",
    profileId: hostAlias,
    profileRevision: 1,
    hostAlias,
    remoteCwd,
    launcherProtocolVersion: 1,
  };
}

function localState(): TerminalTabsState {
  return {
    tabs: [createLocalTerminalTab()],
    activeId: LOCAL_TERMINAL_TAB_ID,
  };
}

test("terminal tabs retain SSH sessions while following conversation targets", () => {
  const work = remoteBinding("work", "/srv/work");
  const staging = remoteBinding("staging", "/srv/staging");

  const withWork = syncTerminalTabsToBinding(localState(), work);
  const workTab = withWork.tabs[1];
  assert.equal(workTab.kind, "ssh");
  assert.equal(withWork.activeId, workTab.id);

  const withStaging = syncTerminalTabsToBinding(withWork, staging);
  assert.equal(withStaging.tabs.length, 3);
  assert.equal(withStaging.tabs[1].id, workTab.id, "the first SSH session must be retained");

  const backToWork = syncTerminalTabsToBinding(withStaging, work);
  assert.equal(backToWork.tabs.length, 3, "an existing binding should be reused");
  assert.equal(backToWork.activeId, workTab.id);

  const backToLocal = syncTerminalTabsToBinding(backToWork, { kind: "local", targetId: "local" });
  assert.equal(backToLocal.activeId, LOCAL_TERMINAL_TAB_ID);
  assert.equal(backToLocal.tabs.length, 3, "selecting local must not close SSH tabs");
});

test("SSH terminal tabs own immutable binding snapshots and unique ids", () => {
  const binding = remoteBinding("work");
  const first = createSshTerminalTab(binding, [createLocalTerminalTab()]);
  const second = createSshTerminalTab(binding, [createLocalTerminalTab(), first]);

  assert.notEqual(first.id, second.id);
  assert.equal(first.name, "work");
  assert.equal(second.name, "work 2");
  assert.notEqual(first.binding, binding);

  binding.remoteCwd = "/mutated";
  assert.equal(first.binding.remoteCwd, "/srv/app");
  assert.equal(sshTerminalBindingKey(first.binding), "work:1:/srv/app");
});

test("closing an active SSH terminal selects its nearest surviving neighbor", () => {
  const first = createSshTerminalTab(remoteBinding("one"), localState().tabs);
  const second = createSshTerminalTab(remoteBinding("two"), [createLocalTerminalTab(), first]);
  const state: TerminalTabsState = {
    tabs: [createLocalTerminalTab(), first, second],
    activeId: first.id,
  };

  const closed = closeTerminalTab(state, first.id);
  assert.deepEqual(closed.tabs.map((tab) => tab.id), [LOCAL_TERMINAL_TAB_ID, second.id]);
  assert.equal(closed.activeId, second.id);
  assert.equal(closeTerminalTab(closed, LOCAL_TERMINAL_TAB_ID), closed, "the last local tab is retained");
});

test("local terminal tabs snapshot cwd, receive unique ids, and close independently", () => {
  const requestedShell = {
    kind: "custom" as const,
    executable: "  C:/Program Files/PowerShell/7/pwsh.exe  ",
  };
  const first = createLocalTerminalTab("C:/projects/one", [], requestedShell);
  requestedShell.executable = "C:/mutated.exe";
  const second = createLocalTerminalTab("C:/projects/two", [first]);
  const third = createLocalTerminalTab("C:/projects/three", [first, second]);
  const ssh = createSshTerminalTab(remoteBinding("work"), [first, second, third]);

  assert.equal(first.id, LOCAL_TERMINAL_TAB_ID);
  assert.notEqual(second.id, first.id);
  assert.notEqual(third.id, second.id);
  assert.deepEqual(
    [first.cwd, second.cwd, third.cwd],
    ["C:/projects/one", "C:/projects/two", "C:/projects/three"],
  );
  assert.deepEqual(first.shellProfile, {
    kind: "custom",
    executable: "C:/Program Files/PowerShell/7/pwsh.exe",
  });
  assert.deepEqual(second.shellProfile, { kind: "auto" });
  assert.deepEqual([first.ordinal, second.ordinal, third.ordinal], [1, 2, 3]);

  const state: TerminalTabsState = { tabs: [first, second, third, ssh], activeId: second.id };
  const closed = closeTerminalTab(state, second.id);
  assert.deepEqual(closed.tabs.map((tab) => tab.id), [first.id, third.id, ssh.id]);
  assert.equal(closed.activeId, third.id);
  assert.notEqual(closeTerminalTab(closed, first.id), closed);
  const lastLocal = closeTerminalTab(closed, first.id);
  assert.equal(closeTerminalTab(lastLocal, third.id), lastLocal, "one local tab must remain");
});

test("terminal tab names are normalized and the tab cap is enforced", () => {
  let state = localState();
  for (let index = 0; index < MAX_TERMINAL_TABS + 2; index += 1) {
    state = syncTerminalTabsToBinding(state, remoteBinding(`host-${index}`));
  }
  assert.equal(state.tabs.length, MAX_TERMINAL_TABS);

  const active = state.tabs.find((tab) => tab.id === state.activeId);
  assert.ok(active);
  const renamed = renameTerminalTab(state, active.id, "  build logs  ");
  assert.equal(renamed.tabs.find((tab) => tab.id === active.id)?.name, "build logs");
});
