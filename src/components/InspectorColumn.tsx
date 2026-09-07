"use client";

/**
 * The docked column beside the conversation and its shared segment control.
 * Task progress, authoritative repository state, and file inspection arbitrate
 * through this one frame instead of opening competing side panels.
 */

import { useEffect } from "react";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { INSPECTOR_PANEL_WIDTH_DEFAULT } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { useFileInspector, type InspectorSegment } from "@/lib/file-inspector";
import { useRepository } from "@/lib/repository";
import { FileInspector } from "./FileInspector";
import { TurnPanel } from "./TurnPanel";
import { RepositoryInspector } from "./RepositoryInspector";
import { IconButton } from "./primitives";

function SegmentButton({
  segment,
  label,
  active,
  disabled,
}: {
  segment: InspectorSegment;
  label: string;
  active: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={() => useFileInspector.getState().setSegment(segment)}
      style={{
        border: "none",
        borderRadius: "var(--radius-sm)",
        padding: "3px 9px",
        fontSize: 11.5,
        fontFamily: "var(--font-ui)",
        cursor: disabled ? "default" : "pointer",
        color: disabled
          ? "var(--text-tertiary)"
          : active
            ? "var(--text-primary)"
            : "var(--text-secondary)",
        opacity: disabled ? 0.45 : 1,
        background: active
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : "transparent",
        transition: "background var(--duration-fast) ease, color var(--duration-fast) ease",
      }}
    >
      {label}
    </button>
  );
}

export function InspectorColumn({ width }: { width?: number }) {
  const t = useT();
  const segment = useFileInspector((s) => s.segment);
  const hasTabs = useFileInspector((s) => s.tabs.length > 0);
  // A file segment with no tabs has nothing to render, so the control falls back
  // rather than showing an empty frame.
  const effective: InspectorSegment = segment === "file" && !hasTabs ? "task" : segment;

  /**
   * Esc returns from a repository diff, then closes the docked column. Because
   * the panel is docked rather than modal, it does not own the key while the caret
   * is in a field. Same contract as the subagent inspector's in AppShell.
   *
   * Mounted here rather than in the file viewer so it works on both segments.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable === true;
      if (typing) return;
      if (useFileInspector.getState().segment === "repository" && useRepository.getState().selected) {
        useRepository.getState().clearSelection();
      } else {
        useFileInspector.getState().close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      aria-label={t("task.panel")}
      className="material"
      style={{
        width: width ?? INSPECTOR_PANEL_WIDTH_DEFAULT,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid var(--separator)",
        flexShrink: 0,
        overflow: "hidden",
        // the file viewer's back-to-latest pill is positioned against this
        position: "relative",
      }}
    >
      <div
        role="tablist"
        aria-label={t("task.panel")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 34,
          flexShrink: 0,
          padding: "0 6px",
          borderBottom: "1px solid var(--separator)",
        }}
      >
        <SegmentButton
          segment="task"
          label={t("task.tabTask")}
          active={effective === "task"}
        />
        <SegmentButton
          segment="repository"
          label={t("repository.tab")}
          active={effective === "repository"}
        />
        <SegmentButton
          segment="file"
          label={t("task.tabFile")}
          active={effective === "file"}
          disabled={!hasTabs}
        />
        <div style={{ marginLeft: "auto" }}>
          <IconButton
            label={t("task.close")}
            onClick={() => useFileInspector.getState().close()}
          >
            <X size={13} />
          </IconButton>
        </div>
      </div>

      {/* keyed so switching segments swaps the content, not the frame */}
      <motion.div
        key={effective}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.09, ease: "easeOut" }}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {effective === "task" ? (
          <TurnPanel />
        ) : effective === "repository" ? (
          <RepositoryInspector />
        ) : (
          <FileInspector />
        )}
      </motion.div>
    </aside>
  );
}
