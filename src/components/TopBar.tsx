"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Chip } from "@appica/ui-react/chip";
import {
  PanelLeft,
  Gem,
  ChevronRight,
  SquareTerminal,
  Moon,
  Sun,
  Focus,
  Sparkles,
  Command,
} from "lucide-react";
import { useUI } from "@/lib/store";
import { usePi } from "@/lib/pi/store";
import { useT } from "@/lib/i18n";
import { IconButton, Kbd } from "./primitives";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { WindowControls } from "./WindowControls";

/**
 * Frameless-style top bar. Acts as the Tauri window drag region.
 * Holds the large-title file name (left) and global controls (right).
 */
export function TopBar() {
  const {
    activeFile,
    toggleSidebar,
    toggleAgentPanel,
    toggleTheme,
    toggleZen,
    toggleTerminal,
    terminalOpen,
    zenMode,
    theme,
    setCommandPalette,
  } = useUI();

  const fileName = activeFile.split("/").pop() ?? activeFile;
  const currentModel = usePi((s) => s.currentModel);
  const cycleModel = usePi((s) => s.cycleModel);
  const t = useT();

  return (
    <header
      className="material-thin"
      data-tauri-drag-region
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 48,
        padding: "0 12px 0 16px", // traffic lights sit over the nav rail now
        borderBottom: "1px solid var(--separator)",
        WebkitUserSelect: "none",
        userSelect: "none",
        zIndex: 20,
      }}
    >
      {!zenMode && (
        <IconButton label={t("topbar.toggleSidebar")} onClick={toggleSidebar}>
          <PanelLeft size={16} />
        </IconButton>
      )}

      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {fileName}
        </span>
        <ProjectSwitcher />
      </div>

      {/* model pill — tap to cycle, link icon to manage */}
      {currentModel && (
        <Chip
          variant="primary"
          size="sm"
          onClick={() => cycleModel()}
          render={
            <motion.button
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 500, damping: 24 }}
            />
          }
          style={{
            marginLeft: "auto",
            gap: 6,
            fontSize: 11.5,
            fontWeight: 500,
            color: "var(--accent)",
            background: "var(--accent-muted)",
            borderRadius: 99,
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          <Gem size={12} style={{ flexShrink: 0 }} />
          {/* iOS-clock-style roll when the model cycles */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={`${currentModel.provider}/${currentModel.id}`}
              initial={{ y: 6, opacity: 0, filter: "blur(2px)" }}
              animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
              exit={{ y: -6, opacity: 0, filter: "blur(2px)" }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              style={{ display: "inline-block" }}
            >
              {currentModel.name ?? currentModel.id}
            </motion.span>
          </AnimatePresence>
          <Link
            href="/models/"
            onClick={(e) => e.stopPropagation()}
            title={t("topbar.manageModels")}
            style={{
              display: "grid",
              placeItems: "center",
              color: "var(--text-tertiary)",
              textDecoration: "none",
            }}
          >
            <ChevronRight size={12} />
          </Link>
        </Chip>
      )}

      {/* command palette pill (⌘K) */}
      <button
        onClick={() => setCommandPalette(true)}
        style={{
          marginLeft: currentModel ? 0 : "auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 30,
          padding: "0 12px",
          fontSize: 12.5,
          color: "var(--text-secondary)",
          background: "var(--bg-sunken)",
          border: "1px solid var(--separator)",
          borderRadius: 99,
          cursor: "pointer",
        }}
      >
        <span>{t("topbar.askAnything")}</span>
        <Kbd>
          <Command size={11} />K
        </Kbd>
      </button>

      <IconButton label={t("topbar.toggleTerminal")} onClick={toggleTerminal} active={terminalOpen}>
        <SquareTerminal size={16} />
      </IconButton>
      <IconButton label={t("topbar.toggleTheme")} onClick={toggleTheme}>
        {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
      </IconButton>
      <IconButton label={t("topbar.zenMode")} onClick={toggleZen} active={zenMode}>
        <Focus size={16} />
      </IconButton>
      {!zenMode && (
        <IconButton label={t("topbar.toggleAgentPanel")} onClick={toggleAgentPanel}>
          <Sparkles size={16} />
        </IconButton>
      )}

      <WindowControls />
    </header>
  );
}
