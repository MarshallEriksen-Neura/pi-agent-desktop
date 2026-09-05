"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import "@xterm/xterm/css/xterm.css";
import {
  APP_MIN_HEIGHT_BESIDE_TERMINAL,
  TERMINAL_HEIGHT_MAX,
  TERMINAL_HEIGHT_MIN,
  useUI,
} from "@/lib/store";
import { isMacPlatform } from "@/lib/shortcuts";
import { ansi, termBus } from "@/lib/terminal-bus";
import { useT } from "@/lib/i18n";
import { Kbd } from "./primitives";
import {
  currentTerminalLine,
  pasteIntoTerminal,
} from "@/lib/terminal-shell";
import {
  FileDown,
  LayoutGrid,
  Plus,
  Server,
  Terminal as TerminalIcon,
  X,
  Command,
} from "lucide-react";
import { formatDroppedPaths } from "@/lib/terminal-drop";
import { useFileDropZone } from "@/lib/use-file-drop";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { TerminalBlocks } from "./TerminalBlocks";
import { TerminalInput } from "./TerminalInput";
import { runPastedLines } from "@/lib/terminal-block-shell";
import { useSessions } from "@/lib/pi/sessions";
import {
  canReadClipboard,
  copyText,
  readClipboardText,
} from "@/lib/terminal-clipboard";
import { clearTerminalView } from "@/lib/terminal-builtins";
import {
  TerminalContextMenu,
  type TerminalMenuItem,
  type TerminalMenuState,
} from "./TerminalContextMenu";
import {
  closeTerminalTab,
  createLocalTerminalTab,
  createSshTerminalTab,
  LOCAL_TERMINAL_TAB_ID,
  MAX_TERMINAL_TABS,
  renameTerminalTab,
  syncTerminalTabsToBinding,
  type TerminalTab,
  type TerminalTabsState,
} from "@/lib/terminal-tabs";
import {
  TerminalXtermPane,
  type TerminalPaneController,
} from "./TerminalXtermPane";
import { PanelResizer } from "./PanelResizer";
import { getBackendKind } from "@/lib/backend/composition/container";
import { LOCAL_WORKSPACE_TARGET } from "@/lib/workspace-target";
import { useWorkspace } from "@/lib/workspace";

function initialTerminalTabs(
  binding: ReturnType<typeof useSessions.getState>["executionBinding"],
  localCwd: string | null,
  shellProfile: ReturnType<typeof useUI.getState>["terminalShellProfile"]
): TerminalTabsState {
  const state: TerminalTabsState = {
    tabs: [createLocalTerminalTab(localCwd, [], shellProfile)],
    activeId: LOCAL_TERMINAL_TAB_ID,
  };
  return syncTerminalTabsToBinding(state, binding);
}

/** Bottom drawer with independently retained native PTYs and a browser-preview fallback. */
export function TerminalDrawer() {
  const {
    terminalOpen,
    setTerminalOpen,
    terminalHeight,
    terminalResizing,
    setTerminalHeight,
    persistTerminalHeight,
    setTerminalResizing,
    resetTerminalHeight,
    terminalShellProfile,
    terminalShellProfileReady,
  } = useUI();
  const executionBinding = useSessions((state) => state.executionBinding);
  const [runtimeBackendKind, setRuntimeBackendKind] = useState<ReturnType<typeof getBackendKind> | null>(
    null
  );
  const nativeLocalTerminals = runtimeBackendKind === "desktop-tauri";
  const localCwd = useWorkspace((state) =>
    state.targetId === LOCAL_WORKSPACE_TARGET
      ? state.root
      : (state.recents.find((project) => project.targetId === LOCAL_WORKSPACE_TARGET)?.path ?? null)
  );
  const workspaceInitialized = useWorkspace((state) => state.initialized);
  const { viewMode, setViewMode } = useTerminalBlocks();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  const [tabsState, setTabsState] = useState<TerminalTabsState>(() =>
    initialTerminalTabs(executionBinding, localCwd, terminalShellProfile),
  );
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [menu, setMenu] = useState<TerminalMenuState | null>(null);
  const [hasOpened, setHasOpened] = useState(false);
  const [mountedTabIds, setMountedTabIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [initialShellSnapshotReady, setInitialShellSnapshotReady] = useState(false);
  const controllersRef = useRef(new Map<string, TerminalPaneController>());

  const activeTab =
    tabsState.tabs.find((tab) => tab.id === tabsState.activeId) ?? tabsState.tabs[0];
  const activeTabRef = useRef<TerminalTab | undefined>(activeTab);
  activeTabRef.current = activeTab;
  const activeUsesNativePty = activeTab?.kind === "ssh" || nativeLocalTerminals;
  const effectiveViewMode = activeUsesNativePty ? "classic" : viewMode;

  useEffect(() => {
    setRuntimeBackendKind(getBackendKind());
  }, []);

  // The fixed first local tab is constructed during SSR with Auto. Replace that
  // provisional value exactly once after client storage hydration, before its pane
  // is allowed to mount. Later preference changes must not mutate tab snapshots.
  useEffect(() => {
    if (!terminalShellProfileReady || initialShellSnapshotReady) return;
    setTabsState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === LOCAL_TERMINAL_TAB_ID &&
        tab.kind === "local" &&
        !mountedTabIds.has(tab.id)
          ? { ...tab, shellProfile: terminalShellProfile }
          : tab
      ),
    }));
    setInitialShellSnapshotReady(true);
  }, [
    initialShellSnapshotReady,
    mountedTabIds,
    terminalShellProfile,
    terminalShellProfileReady,
  ]);

  useEffect(() => {
    if (terminalOpen) setHasOpened(true);
  }, [terminalOpen]);

  // Tabs created while the drawer is hidden stay lazy. Already-mounted PTYs remain
  // mounted, so hiding the drawer never disconnects a running terminal session.
  useEffect(() => {
    if (!terminalOpen || runtimeBackendKind === null) return;
    const tab = tabsState.tabs.find((candidate) => candidate.id === tabsState.activeId);
    if (
      tab?.kind === "local" &&
      nativeLocalTerminals &&
      (!workspaceInitialized || !initialShellSnapshotReady)
    ) {
      return;
    }
    setMountedTabIds((mounted) => {
      if (mounted.has(tabsState.activeId)) return mounted;
      const next = new Set(mounted);
      next.add(tabsState.activeId);
      return next;
    });
  }, [
    initialShellSnapshotReady,
    nativeLocalTerminals,
    runtimeBackendKind,
    tabsState.activeId,
    tabsState.tabs,
    terminalOpen,
    workspaceInitialized,
  ]);


  // The initial tab can be constructed before workspace hydration. Capture the project
  // root exactly once, before that tab has mounted and started its PTY.
  useEffect(() => {
    if (!localCwd || mountedTabIds.has(LOCAL_TERMINAL_TAB_ID)) return;
    setTabsState((state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.id === LOCAL_TERMINAL_TAB_ID && tab.kind === "local" && !tab.cwd
          ? { ...tab, cwd: localCwd }
          : tab,
      ),
    }));
  }, [localCwd, mountedTabIds]);
  // A target switch selects or adds a tab; it never tears down tabs on other hosts.
  useEffect(() => {
    setTabsState((state) => syncTerminalTabsToBinding(state, executionBinding));
  }, [executionBinding]);

  const registerController = useCallback(
    (id: string, controller: TerminalPaneController | null) => {
      if (controller) controllersRef.current.set(id, controller);
      else controllersRef.current.delete(id);
    },
    []
  );

  const activeController = useCallback(() => {
    const tab = activeTabRef.current;
    return tab ? controllersRef.current.get(tab.id) : undefined;
  }, []);

  const insertText = useCallback((text: string) => {
    if (!text) return;
    const tab = activeTabRef.current;
    if (!tab) return;
    if (tab.kind === "ssh" || nativeLocalTerminals) {
      controllersRef.current.get(tab.id)?.terminal.paste(text);
      return;
    }
    const store = useTerminalBlocks.getState();
    if (store.viewMode === "classic") {
      pasteIntoTerminal(text);
      return;
    }
    const tail = runPastedLines(store.input + text);
    useTerminalBlocks.getState().setInput(tail);
  }, [nativeLocalTerminals]);

  const pasteFromClipboard = useCallback(async () => {
    const text = await readClipboardText();
    if (text) {
      insertText(text);
      return;
    }
    const message = ansi.dim(tRef.current("terminal.clipboardUnavailable"));
    const tab = activeTabRef.current;
    if (tab && (tab.kind === "ssh" || nativeLocalTerminals)) {
      controllersRef.current.get(tab.id)?.terminal.writeln(message);
    } else if (useTerminalBlocks.getState().viewMode === "classic") {
      termBus.writeln(message);
    }
  }, [insertText, nativeLocalTerminals]);


  const insertDroppedPaths = useCallback(
    (paths: string[]) => {
      const tab = activeTabRef.current;
      if (!tab) return;
      const text = formatDroppedPaths(paths, {
        precedingLine:
          tab.kind === "ssh" || nativeLocalTerminals
            ? null
            : useTerminalBlocks.getState().viewMode === "classic"
              ? currentTerminalLine()
              : useTerminalBlocks.getState().input,
      });
      insertText(text);
      if (tab.kind === "ssh" || nativeLocalTerminals || useTerminalBlocks.getState().viewMode === "classic") {
        controllersRef.current.get(tab.id)?.terminal.focus();
      }
    },
    [insertText, nativeLocalTerminals]
  );

  const dropZoneRef = useRef<HTMLElement>(null);
  const dropActive = useFileDropZone({
    enabled: terminalOpen,
    targetRef: dropZoneRef,
    onDrop: insertDroppedPaths,
  });

  const addTerminal = useCallback(() => {
    setTabsState((state) => {
      if (state.tabs.length >= MAX_TERMINAL_TABS) return state;
      const selected = state.tabs.find((tab) => tab.id === state.activeId);
      if (selected?.kind === "local") {
        if (!nativeLocalTerminals) return state;
        const tab = createLocalTerminalTab(localCwd, state.tabs, terminalShellProfile);
        return { tabs: [...state.tabs, tab], activeId: tab.id };
      }
      const binding = selected?.kind === "ssh" ? selected.binding : executionBinding;
      if (binding.kind !== "ssh") return state;
      const tab = createSshTerminalTab(binding, state.tabs);
      return { tabs: [...state.tabs, tab], activeId: tab.id };
    });
  }, [executionBinding, localCwd, nativeLocalTerminals, terminalShellProfile]);

  const closeTab = useCallback((id: string) => {
    setTabsState((state) => closeTerminalTab(state, id));
  }, []);

  const startRenaming = useCallback((tab: TerminalTab) => {
    setEditingTabId(tab.id);
    setEditingName(tab.name ?? "");
  }, []);

  const commitRename = useCallback(() => {
    if (!editingTabId) return;
    setTabsState((state) => renameTerminalTab(state, editingTabId, editingName));
    setEditingTabId(null);
  }, [editingName, editingTabId]);

  const [viewportHeight, setViewportHeight] = useState(0);
  useEffect(() => {
    if (!terminalOpen) return;
    const onResize = () => {
      setViewportHeight(window.innerHeight);
      activeController()?.fit();
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [activeController, terminalOpen]);

  const terminalBounds = useCallback(() => {
    const room = viewportHeight
      ? viewportHeight - APP_MIN_HEIGHT_BESIDE_TERMINAL
      : TERMINAL_HEIGHT_MAX;
    return {
      min: TERMINAL_HEIGHT_MIN,
      max: Math.max(TERMINAL_HEIGHT_MIN, Math.min(TERMINAL_HEIGHT_MAX, room)),
    };
  }, [viewportHeight]);

  const effectiveHeight = Math.min(terminalHeight, terminalBounds().max);

  const openMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const tab = activeTabRef.current;
      if (!tab) return;
      const controller = controllersRef.current.get(tab.id);
      const classic =
        tab.kind === "ssh" || nativeLocalTerminals || useTerminalBlocks.getState().viewMode === "classic";
      const selection = classic
        ? (controller?.terminal.getSelection() ?? "")
        : (window.getSelection()?.toString() ?? "");
      const mod = isMacPlatform() ? "⌘" : "Ctrl";
      const items: TerminalMenuItem[] = [
        {
          label: t("terminal.copy"),
          hint: classic ? `${mod}C` : undefined,
          disabled: !selection,
          onSelect: () => {
            void copyText(selection);
            if (classic) controller?.terminal.clearSelection();
          },
        },
        {
          label: t("terminal.paste"),
          hint: `${mod}V`,
          disabled: !canReadClipboard(),
          onSelect: () => void pasteFromClipboard(),
        },
      ];
      if (classic) {
        items.push({
          label: t("terminal.selectAll"),
          onSelect: () => controller?.terminal.selectAll(),
        });
      }
      items.push({
        label: t("terminal.clear"),
        hint: classic ? "Ctrl+L" : undefined,
        onSelect: () => {
          if (tab.kind === "ssh" || nativeLocalTerminals) {
            controller?.terminal.clear();
            controller?.terminal.write("\x1b[3J\x1b[2J\x1b[H");
          } else {
            clearTerminalView();
          }
        },
      });
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [nativeLocalTerminals, pasteFromClipboard, t]
  );

  if (!hasOpened) return null;

  const localTabCount = tabsState.tabs.filter((tab) => tab.kind === "local").length;
  const canAdd =
    tabsState.tabs.length < MAX_TERMINAL_TABS &&
    (activeTab?.kind === "ssh" || (activeTab?.kind === "local" && nativeLocalTerminals));
  const addTitle =
    tabsState.tabs.length >= MAX_TERMINAL_TABS
      ? t("terminal.maxTabs", { count: MAX_TERMINAL_TABS })
      : canAdd
        ? t("terminal.newTab")
        : t("terminal.localTabLimit");

  return (
    <motion.section
      ref={dropZoneRef}
      initial={{ height: 0, opacity: 0 }}
      animate={
        terminalOpen
          ? { height: effectiveHeight, opacity: 1 }
          : { height: 0, opacity: 0 }
      }
      transition={
        terminalResizing
          ? { duration: 0 }
          : { type: "spring", stiffness: 300, damping: 32 }
      }
      onAnimationComplete={() => {
        if (terminalOpen) activeController()?.fit();
      }}
      aria-hidden={!terminalOpen}
      style={{
        overflow: "hidden",
        flexShrink: 0,
        borderTop: "1px solid var(--separator)",
        background: "var(--bg-sunken)",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        pointerEvents: terminalOpen ? "auto" : "none",
      }}
    >
      <PanelResizer
        edge="top"
        width={effectiveHeight}
        bounds={terminalBounds}
        onResize={setTerminalHeight}
        onResizeStateChange={setTerminalResizing}
        onCommit={persistTerminalHeight}
        onReset={resetTerminalHeight}
        label={t("terminal.resize")}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          minHeight: 34,
          padding: "6px 12px 4px 16px",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
          }}
        >
          {t("terminal.title")}
        </span>
        <Kbd style={{ fontSize: 10, background: "transparent", border: "none" }}>
          <Command size={10} />J
        </Kbd>

        {!activeUsesNativePty && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              gap: 4,
              padding: 2,
              background: "var(--bg-base)",
              borderRadius: 6,
              border: "1px solid var(--separator)",
            }}
          >
            <button
              onClick={() => setViewMode("blocks")}
              aria-label={t("terminal.blockView")}
              style={{
                border: "none",
                background: viewMode === "blocks" ? "var(--accent-muted)" : "transparent",
                color: viewMode === "blocks" ? "var(--accent)" : "var(--text-tertiary)",
                cursor: "pointer",
                padding: "4px 8px",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              <LayoutGrid size={12} />
              {t("terminal.blocks")}
            </button>
            <button
              onClick={() => setViewMode("classic")}
              aria-label={t("terminal.classicView")}
              style={{
                border: "none",
                background: viewMode === "classic" ? "var(--accent-muted)" : "transparent",
                color: viewMode === "classic" ? "var(--accent)" : "var(--text-tertiary)",
                cursor: "pointer",
                padding: "4px 8px",
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 500,
              }}
            >
              <TerminalIcon size={12} />
              {t("terminal.classic")}
            </button>
          </div>
        )}

        <button
          onClick={() => setTerminalOpen(false)}
          aria-label={t("terminal.close")}
          style={{
            marginLeft: activeUsesNativePty ? "auto" : undefined,
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: 6,
            display: "flex",
          }}
        >
          <X size={13} />
        </button>
      </div>

      <div
        role="tablist"
        aria-label={t("terminal.tabs")}
        style={{
          display: "flex",
          alignItems: "stretch",
          minHeight: 32,
          padding: "0 10px",
          borderTop: "1px solid color-mix(in srgb, var(--separator) 65%, transparent)",
          borderBottom: "1px solid var(--separator)",
          background: "var(--bg-base)",
          overflowX: "auto",
          flexShrink: 0,
        }}
      >
        {tabsState.tabs.map((tab, index) => {
          const selected = tab.id === tabsState.activeId;
          const canCloseTab = tab.kind === "ssh" || localTabCount > 1;
          const label =
            tab.name ||
            (tab.kind === "local"
              ? tab.ordinal === 1
                ? t("terminal.localTab")
                : t("terminal.localTabNumber", { number: tab.ordinal })
              : tab.binding.hostAlias);
          const title =
            tab.kind === "ssh"
              ? `${tab.binding.hostAlias} · ${tab.binding.remoteCwd}`
              : tab.cwd
                ? `${label} · ${tab.cwd}`
                : label;
          return (
            <span
              key={tab.id}
              style={{
                position: "relative",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                minWidth: 86,
                maxWidth: 180,
                padding: canCloseTab ? "0 5px 0 9px" : "0 9px",
                borderRight: "1px solid var(--separator)",
                color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
                background: selected ? "var(--bg-sunken)" : "transparent",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              <button
                id={`terminal-tab-${tab.id}`}
                type="button"
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                title={title}
                onClick={() =>
                  setTabsState((state) => ({ ...state, activeId: tab.id }))
                }
                onDoubleClick={() => startRenaming(tab)}
                onAuxClick={(event) => {
                  if (event.button === 1 && canCloseTab) closeTab(tab.id);
                }}
                onKeyDown={(event) => {
                  let nextIndex: number | null = null;
                  if (event.key === "ArrowLeft") {
                    nextIndex = (index - 1 + tabsState.tabs.length) % tabsState.tabs.length;
                  } else if (event.key === "ArrowRight") {
                    nextIndex = (index + 1) % tabsState.tabs.length;
                  } else if (event.key === "Home") {
                    nextIndex = 0;
                  } else if (event.key === "End") {
                    nextIndex = tabsState.tabs.length - 1;
                  }
                  if (nextIndex === null) return;
                  event.preventDefault();
                  const nextTab = tabsState.tabs[nextIndex];
                  setTabsState((state) => ({ ...state, activeId: nextTab.id }));
                  requestAnimationFrame(() =>
                    document.getElementById(`terminal-tab-${nextTab.id}`)?.focus()
                  );
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minWidth: 0,
                  flex: 1,
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  padding: 0,
                  cursor: editingTabId === tab.id ? "default" : "pointer",
                  outline: "none",
                  opacity: editingTabId === tab.id ? 0 : 1,
                  pointerEvents: editingTabId === tab.id ? "none" : "auto",
                }}
              >
                {tab.kind === "ssh" ? (
                  <Server size={12} style={{ flexShrink: 0 }} />
                ) : (
                  <TerminalIcon size={12} style={{ flexShrink: 0 }} />
                )}
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 11.5,
                  }}
                >
                  {label}
                </span>
              </button>
              {editingTabId === tab.id && (
                <input
                  autoFocus
                  value={editingName}
                  aria-label={t("terminal.renameTab")}
                  onChange={(event) => setEditingName(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setEditingTabId(null);
                  }}
                  style={{
                    position: "absolute",
                    zIndex: 2,
                    left: 8,
                    right: canCloseTab ? 24 : 8,
                    minWidth: 0,
                    border: "1px solid var(--accent)",
                    borderRadius: 3,
                    background: "var(--bg-base)",
                    color: "var(--text-primary)",
                    font: "inherit",
                    padding: "1px 4px",
                    outline: "none",
                  }}
                />
              )}
              {canCloseTab && (
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  aria-label={t("terminal.closeTab", { name: label })}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "inherit",
                    padding: 2,
                    borderRadius: 4,
                    display: "flex",
                    cursor: "pointer",
                    opacity: selected ? 1 : 0.55,
                    flexShrink: 0,
                  }}
                >
                  <X size={11} />
                </button>
              )}
              {selected && (
                <span
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 8,
                    right: 8,
                    bottom: -1,
                    height: 2,
                    borderRadius: 2,
                    background: "var(--accent)",
                  }}
                />
              )}
            </span>
          );
        })}
        <button
          onClick={addTerminal}
          disabled={!canAdd}
          aria-label={addTitle}
          title={addTitle}
          style={{
            width: 32,
            flex: "0 0 32px",
            border: "none",
            background: "transparent",
            color: canAdd ? "var(--text-secondary)" : "var(--text-quaternary)",
            cursor: canAdd ? "pointer" : "not-allowed",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Plus size={13} />
        </button>
      </div>

      <div
        onContextMenu={openMenu}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {effectiveViewMode === "blocks" && activeTab?.kind === "local" && <TerminalBlocks />}
        {tabsState.tabs
          .filter((tab) => mountedTabIds.has(tab.id))
          .map((tab) => (
            <TerminalXtermPane
              key={tab.id}
              tab={tab}
              visible={
                tab.id === tabsState.activeId &&
                (tab.kind === "ssh" || effectiveViewMode === "classic")
              }
              drawerOpen={terminalOpen}
              onReady={registerController}
              onPasteRequest={pasteFromClipboard}
            />
          ))}
      </div>

      {effectiveViewMode === "blocks" && activeTab?.kind === "local" && <TerminalInput />}

      {dropActive && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 6,
            zIndex: 5,
            borderRadius: 8,
            border: "1.5px dashed var(--accent)",
            background: "var(--accent-muted)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontSize: 12,
            fontWeight: 500,
            color: "var(--accent)",
            pointerEvents: "none",
          }}
        >
          <FileDown size={13} />
          {t("terminal.dropHint")}
        </div>
      )}

      {menu && <TerminalContextMenu state={menu} onClose={() => setMenu(null)} />}
    </motion.section>
  );
}
