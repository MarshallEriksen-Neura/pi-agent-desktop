import type { ExecutionBinding } from "./backend/ports/execution-target";
import {
  AUTO_TERMINAL_SHELL_PROFILE,
  parseTerminalShellProfile,
  type LocalTerminalShellProfile,
} from "./terminal-shell-profile";

export const LOCAL_TERMINAL_TAB_ID = "terminal-local";
export const MAX_TERMINAL_TABS = 8;

export interface LocalTerminalTab {
  id: string;
  kind: "local";
  name: string | null;
  /** Working-directory snapshot captured when this terminal tab is created. */
  cwd: string | null;
  /** Shell-profile snapshot captured when this terminal tab is created. */
  shellProfile: LocalTerminalShellProfile;
  ordinal: number;
}

export interface SshTerminalTab {
  id: string;
  kind: "ssh";
  name: string | null;
  binding: Extract<ExecutionBinding, { kind: "ssh" }>;
}

export type TerminalTab = LocalTerminalTab | SshTerminalTab;

export interface TerminalTabsState {
  tabs: TerminalTab[];
  activeId: string;
}

let sequence = 0;

function nextTerminalId(): string {
  sequence += 1;
  return `terminal_${Date.now().toString(36)}_${sequence.toString(36)}`;
}

export function createLocalTerminalTab(
  cwd: string | null = null,
  tabs: readonly TerminalTab[] = [],
  shellProfile: LocalTerminalShellProfile = AUTO_TERMINAL_SHELL_PROFILE
): LocalTerminalTab {
  const localTabs = tabs.filter((tab): tab is LocalTerminalTab => tab.kind === "local");
  const ordinal = localTabs.reduce((highest, tab) => Math.max(highest, tab.ordinal), 0) + 1;
  return {
    id: localTabs.length === 0 ? LOCAL_TERMINAL_TAB_ID : nextTerminalId(),
    kind: "local",
    name: null,
    cwd,
    shellProfile: parseTerminalShellProfile(shellProfile),
    ordinal,
  };
}

export function createSshTerminalTab(
  binding: Extract<ExecutionBinding, { kind: "ssh" }>,
  tabs: readonly TerminalTab[]
): SshTerminalTab {
  const matchingHostCount = tabs.filter(
    (tab) => tab.kind === "ssh" && tab.binding.hostAlias === binding.hostAlias
).length;
  return {
    id: nextTerminalId(),
    kind: "ssh",
    name: matchingHostCount === 0 ? binding.hostAlias : `${binding.hostAlias} ${matchingHostCount + 1}`,
    binding: { ...binding },
  };
}

export function sshTerminalBindingKey(
  binding: Extract<ExecutionBinding, { kind: "ssh" }>
): string {
  return `${binding.profileId}:${binding.profileRevision}:${binding.remoteCwd}`;
}

/**
 * Follow a conversation target without tearing down terminals from other targets.
 * Existing tabs are reused; a missing SSH target receives an immutable snapshot.
 */
export function syncTerminalTabsToBinding(
  state: TerminalTabsState,
  binding: ExecutionBinding
): TerminalTabsState {
  if (binding.kind === "local") {
    const local = [...state.tabs].reverse().find((tab) => tab.kind === "local");
    return !local || state.activeId === local.id ? state : { ...state, activeId: local.id };
  }

  const key = sshTerminalBindingKey(binding);
  const existing = [...state.tabs]
    .reverse()
    .find((tab) => tab.kind === "ssh" && sshTerminalBindingKey(tab.binding) === key);
  if (existing) {
    return state.activeId === existing.id ? state : { ...state, activeId: existing.id };
  }
  if (state.tabs.length >= MAX_TERMINAL_TABS) return state;

  const tab = createSshTerminalTab(binding, state.tabs);
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/** Close a tab and choose the nearest surviving neighbor; retain at least one local tab. */
export function closeTerminalTab(
  state: TerminalTabsState,
  closingId: string
): TerminalTabsState {
  const closingIndex = state.tabs.findIndex((tab) => tab.id === closingId);
  if (closingIndex < 0) return state;
  const closing = state.tabs[closingIndex];
  if (closing.kind === "local" && state.tabs.filter((tab) => tab.kind === "local").length <= 1) {
    return state;
  }

  const tabs = state.tabs.filter((tab) => tab.id !== closingId);
  if (state.activeId !== closingId) return { ...state, tabs };

  const neighbor = tabs[Math.min(closingIndex, tabs.length - 1)] ?? tabs[0];
  return { tabs, activeId: neighbor.id };
}

export function renameTerminalTab(
  state: TerminalTabsState,
  id: string,
  name: string
): TerminalTabsState {
  const normalized = name.trim();
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === id ? { ...tab, name: normalized || null } : tab
,
    ),
  };
}
