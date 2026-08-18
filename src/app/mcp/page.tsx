"use client";

import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { WindowControls } from "@/components/WindowControls";
import { McpPage } from "@/components/mcp/McpPage";
import { useMcp } from "@/lib/pi/mcp";
import { useT } from "@/lib/i18n";
import { INK, PAPER, SERIF, SANS } from "@/components/mcp/mcp-tokens";

/**
 * MCP servers — standalone Shuimò (水墨) ink-wash page.
 * Pi has no built-in MCP; servers come from the pi-mcp-adapter extension,
 * which reads standard MCP files. This page edits the Pi override files
 * (~/.pi/agent/mcp.json global / .pi/mcp.json project) and restarts pi.
 */
export default function McpSettingsPage() {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const mcp = useMcp();

  useEffect(() => {
    if (!mcp.loaded) void mcp.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={scrollRef}
      style={{
        height: "100%",
        overflowY: "auto",
        background: `linear-gradient(180deg, ${PAPER.top} 0%, ${PAPER.bottom} 100%)`,
      }}
    >
      {/* spin keyframes for the refresh affordance */}
      <style>{`@keyframes mcp-spin { to { transform: rotate(360deg); } }`}</style>

      <div
        data-tauri-drag-region
        style={{
          height: 44,
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          justifyContent: "flex-end",
          padding: "0 12px",
        }}
      >
        <WindowControls />
      </div>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "0 24px 48px" }}>
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          style={{
            margin: "8px 0 4px",
            fontFamily: SERIF,
            fontSize: 32,
            fontWeight: 500,
            letterSpacing: "0.01em",
            color: INK.ink900,
          }}
        >
          {t("mcp.section")}
        </motion.h1>
        <p
          style={{
            margin: "0 0 6px",
            fontSize: 13,
            color: INK.ink500,
            fontFamily: SANS,
          }}
        >
          {t("mcp.pageSubtitle")}
        </p>
        <McpPage />
      </div>
    </div>
  );
}
