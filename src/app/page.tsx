"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import {
  AGENT_PANEL_WIDTH_MAX,
  AGENT_PANEL_WIDTH_MIN,
  INSPECTOR_PANEL_WIDTH_MAX,
  INSPECTOR_PANEL_WIDTH_MIN,
  SUBAGENT_PANEL_WIDTH_MAX,
  SUBAGENT_PANEL_WIDTH_MIN,
  useUI,
} from "@/lib/store";
import {
  SHORTCUT_REGISTRY,
  effectiveBindings,
  isMacPlatform,
  matchesBinding,
} from "@/lib/shortcuts";
import { SubagentPanel, useSubagentPanelOpen } from "@/components/Subagents";
import { FileInspector } from "@/components/FileInspector";
import { useFileInspector } from "@/lib/file-inspector";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { EditorCanvas } from "@/components/EditorCanvas";
import { AgentPanel } from "@/components/AgentPanel";
import { PanelResizer } from "@/components/PanelResizer";
import { CommandPalette } from "@/components/CommandPalette";
import { DiffReviewCard } from "@/components/DiffReviewCard";
import { ModelPicker } from "@/components/ModelPicker";
import { Kbd } from "@/components/primitives";
import { Command, Sparkles } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useSessions } from "@/lib/pi/sessions";

/**
 * xterm is only needed once the drawer opens (⌘J). It renders nothing while
 * closed, so there is no placeholder to show — just keep it off the first load.
 */
const TerminalDrawer = dynamic(
  () => import("@/components/TerminalDrawer").then((m) => m.TerminalDrawer),
  { ssr: false },
);

const springPanel = { type: "spring" as const, stiffness: 300, damping: 30 };

/** Floor for the editor column while the chat rail is dragged wider. */
const EDITOR_MIN_WIDTH = 360;

export default function Home() {
  const {
    sidebarOpen,
    agentPanelOpen,
    agentPanelWidth,
    agentPanelResizing,
    setAgentPanelWidth,
    persistAgentPanelWidth,
    setAgentPanelResizing,
    resetAgentPanelWidth,
    subagentPanelWidth,
    subagentPanelResizing,
    setSubagentPanelWidth,
    persistSubagentPanelWidth,
    setSubagentPanelResizing,
    resetSubagentPanelWidth,
    inspectorPanelWidth,
    inspectorPanelResizing,
    setInspectorPanelWidth,
    persistInspectorPanelWidth,
    setInspectorPanelResizing,
    resetInspectorPanelWidth,
    zenMode,
    workMode,
    layoutMode,
    layoutReady,
    setCommandPalette,
    toggleZen,
    toggleWork,
    startDemo,
    agentRunning,
  } = useUI();
  const t = useT();
  const remoteMode = useSessions((state) => state.executionBinding.kind === "ssh");
  const rowRef = useRef<HTMLDivElement>(null);
  /** live width of the panel row — the drag ceiling and the effective width
   *  both depend on it, and it changes when the window is resized */
  const [rowWidth, setRowWidth] = useState(0);

  /**
   * Global keyboard shortcuts (iOS-clean: one modifier, memorable).
   *
   * The chords come from the shortcut registry rather than being spelled out
   * here, so the settings panel can rebind them and so a rebind is checked
   * against everything else the app binds. Escape stays hard-coded: closing the
   * frontmost overlay is a convention, not a command with a chord.
   */
  useEffect(() => {
    const actions: Record<string, () => void> = {
      commandPalette: () => setCommandPalette(!useUI.getState().commandPaletteOpen),
      ...(!remoteMode
        ? {
            zenMode: () => toggleZen(),
            workMode: () => toggleWork(), // no-op in work-only — no other layout to reach
            toggleTerminal: () => useUI.getState().toggleTerminal(),
          }
        : {}),
    };
    const onKey = (e: KeyboardEvent) => {
      const mac = isMacPlatform();
      const overrides = useUI.getState().shortcutOverrides;
      for (const command of SHORTCUT_REGISTRY) {
        if (command.scope !== "global") continue;
        const run = actions[command.id];
        if (!run) continue;
        const hit = effectiveBindings(command, overrides).some((b) =>
          matchesBinding(e, b, mac)
        );
        if (!hit) continue;
        e.preventDefault();
        run();
        return;
      }
      if (e.key === "Escape") setCommandPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [remoteMode, setCommandPalette, toggleWork, toggleZen]);

  useEffect(() => {
    if (!remoteMode) return;
    // Persisted local layout state must not blank or expose local-only surfaces
    // when the restored conversation is SSH-bound.
    useUI.setState({ zenMode: false, terminalOpen: false });
  }, [remoteMode]);

  /* Nothing mounts until the saved layout is known, so a work-mode launch never
     builds the editor just to tear it down. The boot screen covers the gap. */
  // work-only has no way back to the IDE, so the session list has to stay
  // reachable from the chat column — it would otherwise have no entry point.
  const effectiveWorkMode = workMode || remoteMode;
  /* `remoteMode` used to force work mode here — no sidebar, no editor — from back when
     remote pi was deliberately not editor-first. That is no longer true: a remote target
     has a browsable filesystem (V2.3) and hash-checked writes (V2.4), so the tree and the
     editor work there. Suppressing them left remote mode able to *choose* a project with
     nowhere for that choice to appear.

     The cost is real and worth knowing: every expand and every open is an SSH round trip,
     so the tree is slower than a local one. That is a latency difference, not a
     correctness one. */
  const showSidebar =
    layoutReady && sidebarOpen && !zenMode && (!workMode || layoutMode === "work-only");
  const showAgent = layoutReady && !zenMode && (remoteMode || workMode || agentPanelOpen);
  const showEditor = layoutReady && !zenMode && !workMode;
  /* The inspector follows the chat: it belongs to a conversation, so it appears
     wherever that conversation is and is meaningless without it. Zen mode shows
     nothing but the composer, so it stays out of the way there. */
  const subagentOpen = useSubagentPanelOpen();
  /* One docked column, two possible tenants. Both are opened by clicking a
     transcript row, so the last row clicked wins — the row handlers close the
     other one rather than this deciding a fixed precedence. */
  const inspectorOpen = useFileInspector((s) => s.open && s.tabs.length > 0);
  const showInspector = !remoteMode && inspectorOpen && showAgent;
  const showSubagent = !remoteMode && subagentOpen && showAgent && !showInspector;

  // Track the row's width so the rail can be capped against what's actually
  // available. An observer rather than a window resize listener: the row is also
  // resized by things the window doesn't report, like the nav rail.
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setRowWidth(entry.contentRect.width),
    );
    observer.observe(el);
    setRowWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  /**
   * The widest the rail may be right now: whatever the row can spare above the
   * editor's floor. Measuring the row means the nav rail is already excluded;
   * the sidebar is subtracted because it doesn't shrink.
   *
   * The editor's floor only applies when there is an editor. In work mode the
   * chat is the only flexible column, so reserving another 360px for a column
   * that isn't mounted left the docked panels pinned near their minimum with
   * most of the window free.
   */
  const flexibleFloor = showEditor ? EDITOR_MIN_WIDTH : 0;

  /**
   * The inspector's ceiling. It yields to the rail rather than the other way
   * round: the chat is the primary surface, and an inspector wide enough to
   * squeeze the conversation would defeat the point of docking it beside one.
   */
  const subagentMaxWidth = useMemo(() => {
    if (!rowWidth) return SUBAGENT_PANEL_WIDTH_MAX;
    const room = rowWidth - (showSidebar ? 248 : 0) - AGENT_PANEL_WIDTH_MIN - flexibleFloor;
    return Math.max(
      SUBAGENT_PANEL_WIDTH_MIN,
      Math.min(SUBAGENT_PANEL_WIDTH_MAX, room),
    );
  }, [rowWidth, showSidebar, flexibleFloor]);

  const subagentEffectiveWidth = Math.min(subagentPanelWidth, subagentMaxWidth);

  const subagentPanelBounds = useCallback(
    () => ({ min: SUBAGENT_PANEL_WIDTH_MIN, max: subagentMaxWidth }),
    [subagentMaxWidth],
  );

  /** The file inspector's ceiling — same reasoning as the subagent column's. */
  const inspectorMaxWidth = useMemo(() => {
    if (!rowWidth) return INSPECTOR_PANEL_WIDTH_MAX;
    const room = rowWidth - (showSidebar ? 248 : 0) - AGENT_PANEL_WIDTH_MIN - flexibleFloor;
    return Math.max(
      INSPECTOR_PANEL_WIDTH_MIN,
      Math.min(INSPECTOR_PANEL_WIDTH_MAX, room),
    );
  }, [rowWidth, showSidebar, flexibleFloor]);

  const inspectorEffectiveWidth = Math.min(inspectorPanelWidth, inspectorMaxWidth);

  const inspectorPanelBounds = useCallback(
    () => ({ min: INSPECTOR_PANEL_WIDTH_MIN, max: inspectorMaxWidth }),
    [inspectorMaxWidth],
  );

  const agentMaxWidth = useMemo(() => {
    if (!rowWidth) return AGENT_PANEL_WIDTH_MAX;
    const room =
      rowWidth -
      (showSidebar ? 248 : 0) -
      // the docked inspector is a column too, so the rail cannot claim its space
      (showSubagent ? subagentEffectiveWidth : 0) -
      (showInspector ? inspectorEffectiveWidth : 0) -
      flexibleFloor;
    // A minimum-size window can leave less room than the rail's own floor.
    // Clamping up rather than inverting the range keeps the rail usable and
    // lets the editor be the one that gives.
    return Math.max(AGENT_PANEL_WIDTH_MIN, Math.min(AGENT_PANEL_WIDTH_MAX, room));
  }, [
    rowWidth,
    showSidebar,
    showSubagent,
    subagentEffectiveWidth,
    showInspector,
    inspectorEffectiveWidth,
    flexibleFloor,
  ]);

  /**
   * The rendered width, which is not the same as the saved one. A rail dragged
   * wide on a large window has to fold back on a small one, but the preference
   * itself is kept: widen the window and the rail returns to what the user
   * chose, rather than being permanently trimmed by the narrowest session.
   */
  const agentEffectiveWidth = Math.min(agentPanelWidth, agentMaxWidth);

  const agentPanelBounds = useCallback(
    () => ({ min: AGENT_PANEL_WIDTH_MIN, max: agentMaxWidth }),
    [agentMaxWidth],
  );

  /**
   * The docked column the work-mode chat is sharing the row with, and how to
   * resize it. Null in the editor layouts, where each docked column carries its
   * own handle on the edge it shares with the editor.
   *
   * Two tenants, one column (see showInspector / showSubagent above), so the
   * single handle has to follow whichever is in it.
   */
  const dockedResize = useMemo(() => {
    if (showEditor) return null;
    if (showInspector)
      return {
        width: inspectorEffectiveWidth,
        bounds: inspectorPanelBounds,
        onResize: setInspectorPanelWidth,
        onResizeStateChange: setInspectorPanelResizing,
        onCommit: persistInspectorPanelWidth,
        onReset: resetInspectorPanelWidth,
        label: t("inspector.resize"),
      };
    if (showSubagent)
      return {
        width: subagentEffectiveWidth,
        bounds: subagentPanelBounds,
        onResize: setSubagentPanelWidth,
        onResizeStateChange: setSubagentPanelResizing,
        onCommit: persistSubagentPanelWidth,
        onReset: resetSubagentPanelWidth,
        label: t("subagents.resize"),
      };
    return null;
  }, [
    showEditor,
    showInspector,
    inspectorEffectiveWidth,
    inspectorPanelBounds,
    setInspectorPanelWidth,
    setInspectorPanelResizing,
    persistInspectorPanelWidth,
    resetInspectorPanelWidth,
    showSubagent,
    subagentEffectiveWidth,
    subagentPanelBounds,
    setSubagentPanelWidth,
    setSubagentPanelResizing,
    persistSubagentPanelWidth,
    resetSubagentPanelWidth,
    t,
  ]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: zenMode ? "var(--bg-sunken)" : "var(--bg-base)",
        transition: "background var(--duration-base) var(--spring-smooth)",
      }}
    >
      <TopBar />

      <div
        ref={rowRef}
        style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}
      >
        <AnimatePresence initial={false}>
          {showSidebar && (
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 248, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={springPanel}
              style={{ overflow: "hidden", flexShrink: 0 }}
            >
              <Sidebar />
            </motion.div>
          )}
        </AnimatePresence>

        {showEditor && <EditorCanvas />}

        {/* Subagent inspector — left of the chat, so the conversation that
            spawned it stays visible and answerable while it runs. */}
        <AnimatePresence initial={false}>
          {showSubagent && (
            <motion.div
              key="subagent"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: subagentEffectiveWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={subagentPanelResizing ? { duration: 0 } : springPanel}
              style={{ position: "relative", overflow: "hidden", flexShrink: 0 }}
            >
              {/* Only when an editor sits to the left. In work mode this edge is
                  the window edge, and the seam that can move is the one against
                  the chat — the handle for it is mounted there instead. */}
              {showEditor && (
                <PanelResizer
                  edge="left"
                  width={subagentEffectiveWidth}
                  bounds={subagentPanelBounds}
                  onResize={setSubagentPanelWidth}
                  onResizeStateChange={setSubagentPanelResizing}
                  onCommit={persistSubagentPanelWidth}
                  onReset={resetSubagentPanelWidth}
                  label={t("subagents.resize")}
                />
              )}
              <SubagentPanel width={subagentEffectiveWidth} />
            </motion.div>
          )}
        </AnimatePresence>

        {/* File inspector — same column, same motion: what changed in the file a
            transcript row named, without giving up sight of the conversation. */}
        <AnimatePresence initial={false}>
          {showInspector && (
            <motion.div
              key="inspector"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: inspectorEffectiveWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={inspectorPanelResizing ? { duration: 0 } : springPanel}
              style={{ position: "relative", overflow: "hidden", flexShrink: 0 }}
            >
              {showEditor && (
                <PanelResizer
                  edge="left"
                  width={inspectorEffectiveWidth}
                  bounds={inspectorPanelBounds}
                  onResize={setInspectorPanelWidth}
                  onResizeStateChange={setInspectorPanelResizing}
                  onCommit={persistInspectorPanelWidth}
                  onReset={resetInspectorPanelWidth}
                  label={t("inspector.resize")}
                />
              )}
              <FileInspector width={inspectorEffectiveWidth} />
            </motion.div>
          )}
        </AnimatePresence>

        {showAgent &&
          (effectiveWorkMode ? (
            <motion.div
              key="agent-work"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="sd-work"
              /* tells the stylesheet to keep the left border: with a docked
                 column beside it that edge is a seam, not the window edge */
              data-docked={dockedResize ? "1" : undefined}
            >
              {/* The chat is the flexible column here, so the movable seam is its
                  left edge — but what it resizes is the fixed column on the other
                  side, which is why the handle drives that width and grows the
                  opposite way from where it sits. */}
              {dockedResize && (
                <PanelResizer
                  edge="left"
                  grow="right"
                  width={dockedResize.width}
                  bounds={dockedResize.bounds}
                  onResize={dockedResize.onResize}
                  onResizeStateChange={dockedResize.onResizeStateChange}
                  onCommit={dockedResize.onCommit}
                  onReset={dockedResize.onReset}
                  label={dockedResize.label}
                />
              )}
              <AgentPanel />
            </motion.div>
          ) : (
            <motion.div
              key="agent"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: agentEffectiveWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              /* The spring is right for open/close but wrong for a drag — it
                 would lag a frame or two behind the pointer. */
              transition={agentPanelResizing ? { duration: 0 } : springPanel}
              style={{ position: "relative", overflow: "hidden", flexShrink: 0 }}
            >
              <PanelResizer
                edge="left"
                width={agentEffectiveWidth}
                bounds={agentPanelBounds}
                onResize={setAgentPanelWidth}
                onResizeStateChange={setAgentPanelResizing}
                onCommit={persistAgentPanelWidth}
                onReset={resetAgentPanelWidth}
                label={t("agent.resize")}
              />
              <AgentPanel width={agentEffectiveWidth} />
            </motion.div>
          ))}
      </div>

      {!remoteMode && <TerminalDrawer />}
      {!remoteMode && <DiffReviewCard />}

      {/* Zen-mode floating agent input — the immersive core */}
      <AnimatePresence>
        {zenMode && (
          <>
            <div className={`zen-title${agentRunning ? " is-working" : ""}`}>π Coding Agent</div>
            <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 40 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="material"
            style={{
              position: "fixed",
              bottom: 28,
              left: "50%",
              x: "-50%",
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: 520,
              maxWidth: "80vw",
              padding: "12px 18px",
              borderRadius: 99,
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-lg)",
              zIndex: 40,
            }}
          >
            <span style={{ color: "var(--accent)", fontSize: 16 }}><Sparkles size={16} /></span>
            <input
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const el = e.target as HTMLInputElement;
                const text = el.value.trim();
                if (!text) return;
                el.value = "";
                if (text.toLowerCase() === "demo") {
                  if (!agentRunning) startDemo();
                } else {
                  import("@/lib/pi/chat").then(({ useChat }) =>
                    useChat.getState().send(text)
                  );
                }
              }}
              placeholder={agentRunning ? t("zen.busy") : t("zen.idle")}
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                fontSize: 14,
                color: "var(--text-primary)",
                fontFamily: "var(--font-ui)",
              }}
            />
            <ModelPicker compact />
            <Kbd style={{ fontSize: 11, background: "transparent", border: "none" }}>
              <Command size={10} />.  {t("zen.exit")}
            </Kbd>
          </motion.div>
          </>
        )}
      </AnimatePresence>

      <CommandPalette />
    </div>
  );
}
