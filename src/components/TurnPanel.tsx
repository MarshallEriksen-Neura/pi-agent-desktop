"use client";

/**
 * Task panel — the plan pi is working to, and what this turn changed.
 *
 * Two sections rather than two tabs, because they are one story: what the agent
 * intends and what it has done so far. Switching between them would make the
 * reader hold one half in their head.
 *
 * It costs the transcript no height. Both entry points are things that already
 * exist in the chat header (the status line, and one chip beside it), so the
 * reading column keeps every pixel it had — which is the whole reason this is a
 * docked column and not a bar above the composer.
 */

import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Circle, CircleCheck, CircleDot, Lock } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useTaskContext } from "@/lib/pi/task-context";
import { usePlanItems, usePlanProgress, type PlanItem } from "@/lib/pi/plan";
import { useTurnChanges, type TurnFileChange } from "@/lib/pi/turn";
import { useFileInspector } from "@/lib/file-inspector";
import { relPath } from "@/lib/pi/tool-label";
import { DiffStatBadge } from "./DiffStatBadge";

const STATUS_ICON = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CircleCheck,
} as const;

const STATUS_COLOR = {
  pending: "var(--text-tertiary)",
  in_progress: "var(--agent-thinking)",
  completed: "var(--success)",
} as const;

const STATUS_KEY = {
  pending: "plan.statusPending",
  in_progress: "plan.statusInProgress",
  completed: "plan.statusCompleted",
} as const;

/** Section heading with a summary pinned to the right edge. */
function SectionHead({ title, trailing }: { title: string; trailing?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "12px 14px 6px",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--text-tertiary)",
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {title}
      </span>
      {trailing !== undefined && (
        <span
          style={{
            marginLeft: "auto",
            flexShrink: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            fontWeight: 500,
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          {trailing}
        </span>
      )}
    </div>
  );
}

/** Nothing to show yet — said once, quietly, rather than left blank. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "2px 14px 10px", fontSize: 12, color: "var(--text-tertiary)" }}>
      {children}
    </div>
  );
}

function PlanRow({ item }: { item: PlanItem }) {
  const t = useT();
  const Icon = STATUS_ICON[item.status];
  const running = item.status === "in_progress";
  /* The active step reads in pi's own present tense; the rest keep their subject.
     Two phrasings for one row is deliberate — "正在删除重复块" answers "what is it
     doing" in a way that "删除重复块" does not. */
  const text = running ? item.activeForm ?? item.subject : item.subject;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "3px 14px",
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <span
        className={running ? "pi-icon-breathe" : undefined}
        title={t(STATUS_KEY[item.status])}
        style={{ display: "flex", flexShrink: 0, paddingTop: 3, color: STATUS_COLOR[item.status] }}
      >
        <Icon size={13} strokeWidth={2} />
      </span>
      <span
        style={{
          minWidth: 0,
          color: item.status === "completed" ? "var(--text-tertiary)" : "var(--text-primary)",
          textDecoration: item.status === "completed" ? "line-through" : undefined,
          textDecorationColor: "var(--separator)",
        }}
      >
        {text}
      </span>
      {item.blockedBy !== undefined && item.status !== "completed" && (
        <span
          title={t("plan.blockedBy", { ids: item.blockedBy.join(", ") })}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 3,
            flexShrink: 0,
            paddingTop: 2,
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-tertiary)",
          }}
        >
          <Lock size={10} strokeWidth={2} />
          {item.blockedBy.join(",")}
        </span>
      )}
    </div>
  );
}

function FileRow({ file }: { file: TurnFileChange }) {
  const t = useT();
  const activePath = useFileInspector((s) => s.activePath);
  const segment = useFileInspector((s) => s.segment);
  const active = segment === "file" && activePath === file.path;
  /* The row's diff is the file's newest edit this turn (see turnChanges), so a
     file the agent touched three times opens on what landed last. */
  const open = () =>
    useFileInspector.getState().openTab({
      path: file.path,
      toolCallId: file.toolCallId,
      kind: "edit",
    });

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      aria-label={t("inspector.open", { file: file.path })}
      onClick={open}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      whileHover={{ x: 1 }}
      whileTap={{ scale: 0.995 }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 14px 3px 12px",
        fontSize: 12,
        cursor: "pointer",
        borderLeft: `2px solid ${active ? "var(--accent)" : "transparent"}`,
        background: active ? "color-mix(in srgb, var(--accent) 9%, transparent)" : "transparent",
        transition: "background var(--duration-fast) ease, border-color var(--duration-fast) ease",
      }}
    >
      <span
        title={file.path}
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          direction: "rtl",
          textAlign: "left",
          color: "var(--text-secondary)",
        }}
      >
        {/* rtl truncation keeps the basename when the path is too long — the
            bidi isolate stops it from reordering the path's own separators */}
        <bdi>{relPath(file.path)}</bdi>
      </span>
      <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        {file.edits > 1 && (
          <span
            title={t("turn.edits", { count: String(file.edits) })}
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)" }}
          >
            ×{file.edits}
          </span>
        )}
        <DiffStatBadge
          stat={{
            added: file.added,
            removed: file.removed,
            ...(file.approx ? { approx: true } : {}),
            at: file.at,
          }}
        />
      </span>
    </motion.div>
  );
}

export function TurnPanel() {
  const t = useT();
  const taskId = useTaskContext((s) => s.activeTaskId);
  const items = usePlanItems(taskId);
  const progress = usePlanProgress(taskId);
  const changes = useTurnChanges(taskId);
  const focusSection = useFileInspector((s) => s.focusSection);
  const planRef = useRef<HTMLDivElement>(null);
  const changesRef = useRef<HTMLDivElement>(null);

  /* Land on the section whichever chip opened this asked for, then forget the
     request — it describes one arrival, not a preference. `auto`, not `smooth`: at
     this scroll distance a spring reads as the panel hesitating. */
  useEffect(() => {
    if (!focusSection) return;
    const target = focusSection === "plan" ? planRef.current : changesRef.current;
    target?.scrollIntoView({ block: "start", behavior: "auto" });
    useFileInspector.getState().clearFocusSection();
  }, [focusSection]);

  const fileCount = useMemo(
    () =>
      changes.files.length === 1
        ? t("turn.oneFile")
        : t("turn.files", { count: String(changes.files.length) }),
    [changes.files.length, t],
  );

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 10 }}>
      <div ref={planRef}>
        <SectionHead
          title={t("plan.section")}
          trailing={
            items.length > 0
              ? t("plan.progress", {
                  done: String(progress.done),
                  total: String(progress.total),
                })
              : undefined
          }
        />
        {items.length === 0 ? (
          <Empty>{t("plan.empty")}</Empty>
        ) : (
          items.map((item) => <PlanRow key={item.id} item={item} />)
        )}
      </div>

      <div ref={changesRef} style={{ marginTop: 4 }}>
        <SectionHead
          title={t("turn.section")}
          trailing={
            changes.files.length > 0 ? (
              <span title={changes.approx ? t("turn.approx") : t("turn.sumNote")}>
                {fileCount}
                {"  "}
                <span style={{ color: "var(--diff-add-text)" }}>
                  {changes.approx ? "~" : ""}+{changes.added}
                </span>
                {" "}
                <span style={{ color: "var(--diff-remove-text)" }}>
                  −{changes.removed}
                </span>
              </span>
            ) : undefined
          }
        />
        {changes.files.length === 0 ? (
          <Empty>{t("turn.empty")}</Empty>
        ) : (
          changes.files.map((file) => <FileRow key={file.path} file={file} />)
        )}
      </div>
    </div>
  );
}
