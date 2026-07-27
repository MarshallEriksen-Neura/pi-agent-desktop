"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { useUI } from "@/lib/store";
import { TopBar } from "@/components/TopBar";
import { Sidebar } from "@/components/Sidebar";
import { EditorCanvas } from "@/components/EditorCanvas";
import { AgentPanel } from "@/components/AgentPanel";
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

export default function Home() {
  const {
    sidebarOpen,
    agentPanelOpen,
    zenMode,
    workMode,
    setCommandPalette,
    toggleZen,
    toggleWork,
    startDemo,
    agentRunning,
  } = useUI();
  const t = useT();

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

      <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>
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
              animate={{ width: 320, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={springPanel}
              style={{ overflow: "hidden", flexShrink: 0 }}
            >
              <AgentPanel />
            </motion.div>
          ))}
      </div>

      <TerminalDrawer />
      <DiffReviewCard />

      {/* Zen-mode floating agent input — the immersive core */}
      <AnimatePresence>
        {zenMode && (
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
        )}
      </AnimatePresence>

      <CommandPalette />
    </div>
  );
}
