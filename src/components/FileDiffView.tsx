"use client";

/**
 * The two bodies the file inspector can show: a unified diff of one agent edit,
 * and the file itself.
 *
 * Deliberately unhighlighted. Syntax colour on top of diff tints is two colour
 * systems competing in a 400px column — the tints and the gutters are what
 * answer "what changed", which is the question this panel exists for. The editor
 * is one click away when the answer is "I need to read this properly".
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useT } from "@/lib/i18n";
import { useUI } from "@/lib/store";
import {
  effectiveBindings,
  isMacPlatform,
  matchesBinding,
  shortcutById,
} from "@/lib/shortcuts";
import type { DiffLine, FileDiff } from "@/lib/pi/file-diffs";

/** Rows a diff flattens into — hunk gaps and the truncation notice included. */
type Row =
  | { kind: "gap"; skipped: number; jumpTo: number; hunk: number }
  | { kind: "line"; line: DiffLine; hunk: number }
  | { kind: "cut" };

/** How long a diff still animates its arrival, matching the row badge's window. */
const ARRIVAL_WINDOW_MS = 1500;
/** Lines that stagger in. Past a handful the cascade delays reading. */
const STAGGER_LINES = 8;
const STAGGER_STEP = 0.024;

const GUTTER: React.CSSProperties = {
  width: 34,
  flexShrink: 0,
  textAlign: "right",
  paddingRight: 8,
  color: "var(--text-tertiary)",
  fontVariantNumeric: "tabular-nums",
  userSelect: "none",
};

const CODE: React.CSSProperties = {
  whiteSpace: "pre",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  lineHeight: 1.65,
  color: "var(--text-primary)",
  // a long line scrolls the row, it does not wrap: wrapped code makes the
  // gutters lie about which line you are looking at
  minWidth: 0,
};

function flatten(diff: FileDiff): Row[] {
  const rows: Row[] = [];
  diff.hunks.forEach((hunk, i) => {
    if (hunk.gap > 0) {
      rows.push({
        kind: "gap",
        skipped: hunk.gap,
        // the first new-side line of this hunk, so "view source" lands where the
        // reader was already looking
        jumpTo: hunk.newStart,
        hunk: i,
      });
    }
    for (const line of hunk.lines) rows.push({ kind: "line", line, hunk: i });
  });
  if (diff.truncated) rows.push({ kind: "cut" });
  return rows;
}

/** Background + sign colour for one diff line. */
function tint(kind: DiffLine["kind"]): {
  background: string;
  border: string;
  sign: string;
} {
  if (kind === "+") {
    return {
      background: "var(--diff-add-bg)",
      border: "var(--success)",
      sign: "var(--diff-add-text)",
    };
  }
  if (kind === "-") {
    return {
      background: "var(--diff-remove-bg)",
      border: "var(--danger)",
      sign: "var(--diff-remove-text)",
    };
  }
  return { background: "transparent", border: "transparent", sign: "transparent" };
}

/**
 * A unified diff of one edit.
 *
 * Capped at 400 rows upstream, so this renders straight rather than virtualizing
 * — one scroll container whose row heights are all known beats a measured list
 * for something this size, and text selection across the whole diff keeps working.
 */
export function DiffBody({
  diff,
  onViewSource,
}: {
  diff: FileDiff;
  /** switch to the source view, positioned at `line` */
  onViewSource: (line: number) => void;
}) {
  const t = useT();
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  const rows = useMemo(() => flatten(diff), [diff]);
  const animated = !reduced && Date.now() - diff.at < ARRIVAL_WINDOW_MS;
  const hunks = diff.hunks.length;

  /** Scroll hunk `i` to the top of the body and remember where we are. */
  const goTo = (i: number) => {
    const next = (i + hunks) % hunks;
    setCursor(next);
    scroller.current
      ?.querySelector(`[data-hunk-anchor="${next}"]`)
      ?.scrollIntoView({ block: "start", behavior: reduced ? "auto" : "smooth" });
  };

  // ⌥↓ / ⌥↑ walk the hunks by default, rebindable in settings. Alt-modified so
  // nothing is taken away from the composer or from the browser's own find — and
  // skipped outright while the caret is in a field, which belongs to whatever is
  // being typed into.
  useEffect(() => {
    if (hunks < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el?.isContentEditable === true
      ) {
        return;
      }
      const { shortcutOverrides } = useUI.getState();
      const mac = isMacPlatform();
      const hits = (id: string) => {
        const command = shortcutById(id);
        if (!command) return false;
        return effectiveBindings(command, shortcutOverrides).some((b) =>
          matchesBinding(e, b, mac)
        );
      };
      const step = hits("nextHunk") ? 1 : hits("prevHunk") ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      goTo(cursor + step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `goTo` closes over `cursor`, so the listener is re-bound when it moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, hunks, reduced]);

  /**
   * Keep the counter honest while the user scrolls by hand. Without this the
   * `3/7` reports where the last jump landed, so scrolling past four hunks and
   * pressing ⌥↓ walks back to somewhere already read.
   */
  useEffect(() => {
    const root = scroller.current;
    if (!root || hunks < 2) return;
    const anchors = Array.from(root.querySelectorAll<HTMLElement>("[data-hunk-anchor]"));
    if (anchors.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;
        // the highest one still on screen is the hunk being read
        const top = visible.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b,
        );
        const n = Number((top.target as HTMLElement).dataset.hunkAnchor);
        if (Number.isInteger(n)) setCursor(n);
      },
      // only the top third counts as "here", so a hunk scrolling off the bottom
      // does not keep claiming the counter
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    anchors.forEach((anchor) => observer.observe(anchor));
    return () => observer.disconnect();
  }, [rows, hunks]);

  let staggered = 0;

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      {hunks > 1 && <HunkNav at={cursor} of={hunks} onGo={goTo} />}
      <div
        ref={scroller}
        style={{ height: "100%", overflow: "auto", padding: "6px 0 14px" }}
      >
        {rows.map((row, i) => {
          if (row.kind === "cut") {
            return (
              <div key="cut" style={noticeStyle}>
                {t("inspector.truncated", { count: diff.hunks.reduce((n, h) => n + h.lines.length, 0) })}
              </div>
            );
          }
          if (row.kind === "gap") {
            return (
              <button
                key={`gap-${i}`}
                type="button"
                data-hunk-anchor={row.hunk}
                onClick={() => onViewSource(row.jumpTo)}
                className="pi-row"
                style={gapStyle}
              >
                <span style={{ opacity: 0.5 }}>⋯</span>
                {t("inspector.unchangedLines", { count: row.skipped })}
                <span style={{ color: "var(--accent)" }}>{t("inspector.viewSource")}</span>
              </button>
            );
          }

          const { line } = row;
          const colors = tint(line.kind);
          const delay = animated && staggered < STAGGER_LINES ? staggered++ * STAGGER_STEP : 0;
          const anchor = i === 0 || rows[i - 1].kind !== "line" ? row.hunk : undefined;

          return (
            <motion.div
              key={i}
              {...(anchor !== undefined ? { "data-hunk-anchor": anchor } : {})}
              initial={animated ? { opacity: 0 } : false}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1], delay }}
              style={{
                display: "flex",
                alignItems: "baseline",
                background: colors.background,
                borderLeft: `2px solid ${colors.border}`,
                ...CODE,
              }}
            >
              <span style={GUTTER}>{line.oldLine ?? ""}</span>
              <span style={GUTTER}>{line.newLine ?? ""}</span>
              <span
                aria-hidden
                style={{ width: 12, flexShrink: 0, color: colors.sign, userSelect: "none" }}
              >
                {line.kind === " " ? "" : line.kind === "+" ? "+" : "−"}
              </span>
              {line.kind !== " " && (
                <span className="sr-only">
                  {t(line.kind === "+" ? "inspector.added" : "inspector.removed")}
                </span>
              )}
              <span style={{ paddingRight: 12 }}>{line.text || " "}</span>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

const noticeStyle: React.CSSProperties = {
  margin: "8px 12px 0",
  padding: "7px 10px",
  borderRadius: "var(--radius-sm)",
  background: "var(--bg-sunken)",
  color: "var(--text-tertiary)",
  fontSize: 11,
  lineHeight: 1.5,
};

const gapStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 12px",
  border: "none",
  borderTop: "1px solid var(--separator)",
  borderBottom: "1px solid var(--separator)",
  background: "var(--bg-sunken)",
  color: "var(--text-tertiary)",
  fontFamily: "var(--font-ui)",
  fontSize: 10.5,
  cursor: "pointer",
  textAlign: "left",
};

/** `3 / 7` plus the two steppers, floating over the diff it walks. */
function HunkNav({
  at,
  of,
  onGo,
}: {
  at: number;
  of: number;
  onGo: (i: number) => void;
}) {
  const t = useT();
  return (
    <div
      className="material"
      style={{
        position: "absolute",
        top: 8,
        right: 12,
        zIndex: 2,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "2px 4px 2px 8px",
        borderRadius: 99,
        border: "1px solid var(--separator)",
        boxShadow: "var(--shadow-sm)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        color: "var(--text-secondary)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>{`${at + 1}/${of}`}</span>
      <button
        type="button"
        aria-label={t("inspector.prevChange")}
        onClick={() => onGo(at - 1)}
        style={stepperStyle}
      >
        <ChevronUp size={12} />
      </button>
      <button
        type="button"
        aria-label={t("inspector.nextChange")}
        onClick={() => onGo(at + 1)}
        style={stepperStyle}
      >
        <ChevronDown size={12} />
      </button>
    </div>
  );
}

const stepperStyle: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 18,
  height: 18,
  border: "none",
  borderRadius: 99,
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  padding: 0,
};

/**
 * The file as it is on disk, virtualized.
 *
 * Lines the last recorded edit touched keep a faint tint here too. Switching to
 * source to read around a change should not cost you the knowledge of where the
 * change was — that is the whole reason the gap rows point here.
 */
export function SourceBody({
  text,
  changed,
  jump,
}: {
  text: string;
  /** 1-based new-side line numbers the tab's edit added */
  changed?: Set<number>;
  /** scroll target; the nonce is what makes a repeat jump to the same line work */
  jump?: { line: number; nonce: number };
}) {
  const list = useRef<VirtuosoHandle>(null);
  const lines = useMemo(() => text.split("\n"), [text]);

  useEffect(() => {
    if (!jump) return;
    list.current?.scrollToIndex({
      index: Math.min(Math.max(jump.line - 1, 0), lines.length - 1),
      align: "center",
    });
  }, [jump, lines.length]);

  return (
    <Virtuoso
      ref={list}
      style={{ flex: 1, minHeight: 0 }}
      totalCount={lines.length}
      increaseViewportBy={240}
      itemContent={(i) => (
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            background: changed?.has(i + 1) ? "var(--diff-add-bg)" : "transparent",
            ...CODE,
          }}
        >
          <span style={GUTTER}>{i + 1}</span>
          <span style={{ paddingRight: 12 }}>{lines[i] || " "}</span>
        </div>
      )}
    />
  );
}
