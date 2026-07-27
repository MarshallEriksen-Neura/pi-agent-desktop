"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Chip } from "@appica/ui-react/chip";
import {
  PanelLeft,
  ArrowDownToLine,
  X,
  SquareTerminal,
  Moon,
  Sun,
  Focus,
  Sparkles,
  MessagesSquare,
  Command,
} from "lucide-react";
import { useUI } from "@/lib/store";
import { useUpdate } from "@/lib/update";
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
    toggleWork,
    toggleTerminal,
    terminalOpen,
    zenMode,
    workMode,
    theme,
    setCommandPalette,
  } = useUI();

  const fileName = activeFile.split("/").pop() ?? activeFile;
  const updatePhase = useUpdate((s) => s.phase);
  const updateInfo = useUpdate((s) => s.info);
  const updateDismissed = useUpdate((s) => s.dismissed);
  const dismissUpdate = useUpdate((s) => s.dismiss);
  const t = useT();
  const router = useRouter();

  // one silent check on launch so the reminder can surface without visiting settings
  useEffect(() => {
    const { phase, lastCheckedAt, check } = useUpdate.getState();
    if (phase === "idle" && lastCheckedAt === null) void check();
  }, []);

  const showUpdate = updatePhase === "available" && !updateDismissed;

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
      {!zenMode && !workMode && (
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

      {/* update reminder pill — only when a desktop update is available; tap to open the update page */}
      <AnimatePresence initial={false}>
        {showUpdate && (
          <Chip
            variant="primary"
            size="sm"
            onClick={() => router.push("/update/")}
            render={
              <motion.button
                initial={{ opacity: 0, scale: 0.9, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: -4 }}
                whileTap={{ scale: 0.95 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
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
            <ArrowDownToLine size={12} style={{ flexShrink: 0 }} />
            <span>
              {updateInfo?.latestVersion
                ? t("topbar.updateAvailableVersion", { version: updateInfo.latestVersion })
                : t("topbar.updateAvailable")}
            </span>
            <span
              role="button"
              title={t("topbar.dismissUpdate")}
              onClick={(e) => {
                e.stopPropagation();
                dismissUpdate();
              }}
              style={{
                display: "grid",
                placeItems: "center",
                color: "var(--text-tertiary)",
                cursor: "pointer",
              }}
            >
              <X size={12} />
            </span>
          </Chip>
        )}
      </AnimatePresence>

      {/* command palette pill (⌘K) */}
      <button
        onClick={() => setCommandPalette(true)}
        style={{
          marginLeft: showUpdate ? 0 : "auto",
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
      <IconButton label={t("topbar.workMode")} onClick={toggleWork} active={workMode}>
        <MessagesSquare size={16} />
      </IconButton>
      {!zenMode && !workMode && (
        <IconButton label={t("topbar.toggleAgentPanel")} onClick={toggleAgentPanel}>
          <Sparkles size={16} />
        </IconButton>
      )}

      <WindowControls />
    </header>
  );
}
