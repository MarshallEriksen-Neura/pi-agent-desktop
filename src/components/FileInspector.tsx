"use client";

/**
 * File inspector — the file behind a transcript row, docked beside the
 * conversation that mentioned it.
 *
 * Two things make this more than a viewer. It shows the *diff* of an agent edit,
 * not just the file after it, so "what did that change" is answerable without
 * leaving the chat. And it can be pinned: the agent no longer drags the view to
 * whatever it is writing while you are reading something else (see
 * file-inspector's `follow`).
 *
 * Structurally a sibling of SubagentPanel — same column, same chrome, same
 * material — because both answer "show me more about that row", and a surface
 * that appears in the same place should look and move the same way.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Pin, PinOff, X } from "lucide-react";
import { useUI } from "@/lib/store";
import { useWorkspace } from "@/lib/workspace";
import { useFileDiffs } from "@/lib/pi/file-diffs";
import { useActiveTab, useFileInspector } from "@/lib/file-inspector";
import { relPath } from "@/lib/pi/tool-label";
import { useT } from "@/lib/i18n";
import { DiffBody, SourceBody } from "./FileDiffView";

/** basename, plus its parent when another open tab shares the same name */
function label(path: string, paths: string[]): string {
  const name = path.split("/").pop() ?? path;
  const clashes = paths.filter((p) => (p.split("/").pop() ?? p) === name).length > 1;
  if (!clashes) return name;
  const parent = path.split("/").slice(-2, -1)[0];
  return parent ? `${parent}/${name}` : name;
}

/**
 * The file segment of the docked column — body only. The frame, the width and the
 * close button belong to `InspectorColumn`, which is what the two segments share.
 */
export function FileInspector() {
  const t = useT();
  const tabs = useFileInspector((s) => s.tabs);
  const view = useFileInspector((s) => s.view);
  const follow = useFileInspector((s) => s.follow);
  const missed = useFileInspector((s) => s.missed);
  const tab = useActiveTab();
  const layoutMode = useUI((s) => s.layoutMode);
  const diff = useFileDiffs((s) => (tab?.toolCallId ? s.diffs[tab.toolCallId] : undefined));
  const doc = useWorkspace((s) => (tab ? s.docs[tab.path] : undefined));
  const [jump, setJump] = useState<{ line: number; nonce: number } | undefined>();

  const showDiff = view === "diff" && diff !== undefined;

  /**
   * Edits to this file recorded after the call that opened the tab. A `Read` row
   * shows the file as it is *now*, so without this the panel would quietly
   * present post-edit content as what the agent read.
   */
  const staleEdits = useFileDiffs((s) => {
    const since = tab?.sinceAt;
    if (!tab || since === undefined) return 0;
    let n = 0;
    for (const d of Object.values(s.diffs)) {
      if (d.path === tab.path && d.at > since) n++;
    }
    return n;
  });

  /** new-side lines the tab's edit added — tinted in the source view too */
  const changed = useMemo(() => {
    if (!diff) return undefined;
    const set = new Set<number>();
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "+" && line.newLine !== undefined) set.add(line.newLine);
      }
    }
    return set;
  }, [diff]);

  // the text is only needed by the source view, so it is fetched when that view
  // is the one showing — and without touching what the editor has open
  useEffect(() => {
    if (!tab || showDiff || doc !== undefined) return;
    void useWorkspace.getState().ensureDoc(tab.path);
  }, [tab, showDiff, doc]);

  /* Esc closes the column — handled by `InspectorColumn`, which owns the frame, so
     it works on both segments rather than only while a file is showing. */

  const viewSource = (line: number) => {
    useFileInspector.getState().setView("source");
    setJump({ line, nonce: Date.now() });
  };

  // work-only has no editor to reach, so the escape hatch is hidden rather than
  // offered and then found to do nothing
  const canReachEditor = layoutMode !== "work-only";
  const openInEditor = () => {
    if (!tab) return;
    void useWorkspace.getState().openFile(tab.path);
    if (useUI.getState().workMode) useUI.getState().toggleWork();
    useFileInspector.getState().close();
  };

  if (!tab) return null;
  const names = tabs.map((item) => item.path);

  return (
    <>
      {/* tab strip */}
      <div
        role="tablist"
        aria-label={t("inspector.title")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 34,
          flexShrink: 0,
          padding: "0 6px",
          borderBottom: "1px solid var(--separator)",
          overflowX: "auto",
          scrollbarWidth: "none",
        }}
      >
        {tabs.map((item) => (
          <TabChip
            key={item.path}
            label={label(item.path, names)}
            path={item.path}
            active={item.path === tab.path}
            onSelect={() => useFileInspector.getState().select(item.path)}
            onClose={() => useFileInspector.getState().closeTab(item.path)}
          />
        ))}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 2 }}>
          <IconButton
            label={follow ? t("inspector.following") : t("inspector.pinned")}
            active={follow}
            onClick={() => useFileInspector.getState().toggleFollow()}
          >
            {follow ? <Pin size={12} /> : <PinOff size={12} />}
          </IconButton>
        </div>
      </div>

      {/* path + view switch */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 10px 8px 12px",
          flexShrink: 0,
        }}
      >
        <span
          title={tab.path}
          style={{
            minWidth: 0,
            flex: 1,
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--text-tertiary)",
            // truncate from the left: the tail of a path is the part that
            // identifies the file
            direction: "rtl",
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {relPath(tab.path)}
        </span>
        {diff && (
          <ViewSwitch
            view={view}
            added={diff.added}
            removed={diff.removed}
            approx={diff.approx}
            onChange={(next) => useFileInspector.getState().setView(next)}
          />
        )}
      </div>

      {/* body — keyed so a tab or view change swaps the content, not the frame */}
      <motion.div
        key={`${tab.path}:${showDiff ? "diff" : "source"}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.09, ease: "easeOut" }}
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        {showDiff ? (
          <DiffBody diff={diff} onViewSource={viewSource} />
        ) : doc !== undefined ? (
          <SourceBody text={doc} changed={changed} jump={jump} />
        ) : (
          <Placeholder
            text={
              view === "diff" && !diff
                ? t("inspector.diffReleased")
                : t("inspector.loading")
            }
          />
        )}
      </motion.div>

      {/* back-to-latest — only while pinned and behind */}
      <AnimatePresence>
        {missed > 0 && !follow && (
          <motion.button
            key="missed"
            type="button"
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            onClick={() => useFileInspector.getState().resumeFollow()}
            className="material"
            style={{
              position: "absolute",
              bottom: 44,
              left: "50%",
              translate: "-50%",
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "5px 12px",
              borderRadius: 99,
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-md)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
              fontSize: 11.5,
              cursor: "pointer",
              zIndex: 3,
            }}
          >
            {t("inspector.newChanges", { count: missed })}
            <span style={{ color: "var(--accent)" }}>{t("inspector.backToLatest")}</span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* footer: what you are looking at, and the way out */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexShrink: 0,
          minHeight: 30,
          padding: "0 10px 0 12px",
          borderTop: "1px solid var(--separator)",
          fontFamily: "var(--font-ui)",
          fontSize: 10.5,
          color: "var(--text-tertiary)",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {showDiff
            ? diff.approx
              ? t("inspector.approx")
              : t("inspector.diffAgainstBefore")
            : view === "diff" && tab.toolCallId !== undefined
              ? t("inspector.diffReleased")
              : staleEdits > 0
                ? t("inspector.staleRead", { count: staleEdits })
                : t("inspector.readOnly")}
        </span>
        {canReachEditor && (
          <button
            type="button"
            onClick={openInEditor}
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              flexShrink: 0,
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              fontFamily: "inherit",
              fontSize: 10.5,
              cursor: "pointer",
              padding: "6px 0",
            }}
          >
            {t("inspector.openInEditor")}
            <ExternalLink size={11} />
          </button>
        )}
      </div>
    </>
  );
}

/**
 * One file in the strip. The close affordance is on the active tab only —
 * six chips each carrying an × is a row of noise, and middle-click closes any of
 * them the way a tab is closed everywhere else.
 */
function TabChip({
  label: text,
  path,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  path: string;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        flexShrink: 0,
        height: 24,
        padding: active ? "0 4px 0 8px" : "0 8px",
        borderRadius: "var(--radius-sm)",
        background: active
          ? "color-mix(in srgb, var(--accent) 11%, transparent)"
          : "transparent",
        transition: "background var(--duration-fast) ease",
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={path}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1) onClose();
        }}
        style={{
          border: "none",
          background: "transparent",
          padding: 0,
          maxWidth: 132,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-ui)",
          fontSize: 11.5,
          fontWeight: active ? 600 : 500,
          color: active ? "var(--text-primary)" : "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        {text}
      </button>
      {active && (
        <button
          type="button"
          aria-label={t("inspector.closeTab")}
          onClick={onClose}
          style={{
            display: "grid",
            placeItems: "center",
            width: 16,
            height: 16,
            border: "none",
            borderRadius: 99,
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            padding: 0,
          }}
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/**
 * Source ⇄ Changes. The indicator slides between the two rather than each label
 * fading its own colour: one moving object reads as one control with a position,
 * which is what a segmented control is supposed to communicate.
 */
function ViewSwitch({
  view,
  added,
  removed,
  approx,
  onChange,
}: {
  view: "source" | "diff";
  added: number;
  removed: number;
  approx?: boolean;
  onChange: (view: "source" | "diff") => void;
}) {
  const t = useT();
  const options: Array<{ id: "source" | "diff"; text: string }> = [
    { id: "source", text: t("inspector.source") },
    { id: "diff", text: t("inspector.changes") },
  ];

  return (
    <div
      role="group"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        flexShrink: 0,
        padding: 2,
        borderRadius: 99,
        background: "var(--bg-sunken)",
      }}
    >
      {options.map((option) => {
        const active = option.id === view;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              border: "none",
              background: "transparent",
              borderRadius: 99,
              padding: "3px 9px",
              fontFamily: "var(--font-ui)",
              fontSize: 11,
              fontWeight: active ? 600 : 500,
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {active && (
              <motion.span
                layoutId="inspector-view-pill"
                transition={{ type: "spring", stiffness: 480, damping: 38 }}
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 99,
                  background: "var(--bg-base)",
                  boxShadow: "var(--shadow-sm)",
                  zIndex: -1,
                }}
              />
            )}
            <span>{option.text}</span>
            {option.id === "diff" && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--text-tertiary)",
                }}
              >
                {approx && "~"}
                {added > 0 && <span style={{ color: "var(--success)" }}>+{added}</span>}
                {added > 0 && removed > 0 && " "}
                {removed > 0 && <span style={{ color: "var(--danger)" }}>−{removed}</span>}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function IconButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      style={{
        display: "grid",
        placeItems: "center",
        width: 22,
        height: 22,
        flexShrink: 0,
        border: "none",
        borderRadius: "var(--radius-sm)",
        background: active
          ? "color-mix(in srgb, var(--accent) 12%, transparent)"
          : "transparent",
        color: active ? "var(--accent)" : "var(--text-tertiary)",
        cursor: "pointer",
        padding: 0,
        transition: "background var(--duration-fast) ease, color var(--duration-fast) ease",
      }}
    >
      {children}
    </button>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        placeItems: "center",
        padding: 20,
        textAlign: "center",
        fontFamily: "var(--font-ui)",
        fontSize: 11.5,
        color: "var(--text-tertiary)",
      }}
    >
      {text}
    </div>
  );
}
