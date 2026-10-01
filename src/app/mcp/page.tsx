"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { WindowControls } from "@/components/WindowControls";
import { McpPage } from "@/components/mcp/McpPage";
import { createMcpStore, useMcp } from "@/lib/pi/mcp";
import { useT } from "@/lib/i18n";
import { INK, PAPER, SERIF, SANS } from "@/components/mcp/mcp-tokens";
import { useAppearance } from "@/lib/appearance";

import { useSessions } from "@/lib/pi/sessions";
import { piManagementTargetKey } from "@/lib/backend/ports/pi-management";
import { getPort } from "@/lib/backend/composition/container";
import type { ExecutionBinding } from "@/lib/backend/ports/execution-target";
import { usePiManagement } from "@/lib/pi/management";
/**
 * MCP servers — standalone Shuimò (水墨) ink-wash page.
 * Pi has no built-in MCP; servers come from the pi-mcp-adapter extension,
 * which reads standard MCP files. This page edits the Pi override files
 * (effective agent mcp.json / project .pi/mcp.json). Restart is explicit.
 */
export default function McpSettingsPage() {
  const binding = useSessions((state) => state.executionBinding);
  return binding.kind === "ssh"
    ? <RemoteMcpSettingsPage key={piManagementTargetKey(binding, null)} binding={binding} />
    : <McpSettingsContent />;
}

function RemoteMcpSettingsPage({ binding }: { binding: Extract<ExecutionBinding, { kind: "ssh" }> }) {
  const [store] = useState(() => {
    const context = { binding, projectRoot: null, targetKey: piManagementTargetKey(binding, null),
      port: getPort("createPiManagement")(binding, null) };
    return createMcpStore(getPort("createMcpConfiguration")(binding),
      (scope) => usePiManagement.getState().markDirty(scope, context));
  });
  return <McpSettingsContent store={store} target={`${binding.hostAlias} · ${binding.remoteCwd}`} />;
}

function McpSettingsContent({ store = useMcp, target }: { store?: typeof useMcp; target?: string }) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);

  const { bgImage } = useAppearance();

  return (
    <div
      ref={scrollRef}
      style={{
        height: "100%",
        overflowY: "auto",
        background: bgImage
          ? `linear-gradient(180deg, color-mix(in srgb, ${PAPER.top} 76%, transparent) 0%, color-mix(in srgb, ${PAPER.bottom} 76%, transparent) 100%)`
          : `linear-gradient(180deg, ${PAPER.top} 0%, ${PAPER.bottom} 100%)`,
        backdropFilter: bgImage ? "blur(18px) saturate(120%)" : undefined,
        WebkitBackdropFilter: bgImage ? "blur(18px) saturate(120%)" : undefined,
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
          {target ? t("mcp.remoteEditSubtitle", { target }) : t("mcp.pageSubtitle")}
        </p>
        <McpPage store={store} />
      </div>
    </div>
  );
}
