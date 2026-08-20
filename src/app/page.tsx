"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import {
  AGENT_PANEL_WIDTH_MAX,
  AGENT_PANEL_WIDTH_MIN,
  useUI,
} from "@/lib/store";
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
    zenMode,
    workMode,
    setCommandPalette,
    toggleZen,
    toggleWork,
    startDemo,
    agentRunning,
  } = useUI();
  const t = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  /** live width of the panel row — the drag ceiling and the effective width
   *  both depend on it, and it changes when the window is resized */
  const [rowWidth, setRowWidth] = useState(0);

  // Global keyboard shortcuts (iOS-clean: one modifier, memorable)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandPalette(!useUI.getState().commandPaletteOpen);
      }
      if (mod && e.key === ".") {
        e.preventDefault();
        toggleZen();
      }
      if (mod && e.key === "/") {
        e.preventDefault();
        toggleWork();
      }
      if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        useUI.getState().toggleTerminal();
      }
      if (e.key === "Escape") setCommandPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCommandPalette, toggleZen]);

  const showSidebar = sidebarOpen && !zenMode && !workMode;
  const showAgent = !zenMode && (workMode || agentPanelOpen);
  const showEditor = !zenMode && !workMode;

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
   */
  const agentMaxWidth = useMemo(() => {
    if (!rowWidth) return AGENT_PANEL_WIDTH_MAX;
    const room = rowWidth - (showSidebar ? 248 : 0) - EDITOR_MIN_WIDTH;
    // A minimum-size window can leave less room than the rail's own floor.
    // Clamping up rather than inverting the range keeps the rail usable and
    // lets the editor be the one that gives.
    return Math.max(AGENT_PANEL_WIDTH_MIN, Math.min(AGENT_PANEL_WIDTH_MAX, room));
  }, [rowWidth, showSidebar]);

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

        {showAgent &&
          (workMode ? (
            <motion.div
              key="agent-work"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="sd-work"
            >
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

      <TerminalDrawer />
      <DiffReviewCard />

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
