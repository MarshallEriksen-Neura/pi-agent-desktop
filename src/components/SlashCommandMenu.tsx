"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { SlashItem } from "@/lib/pi/commands";
import { useT } from "@/lib/i18n";

/**
 * Composer slash-command popover — appears above the input while the draft
 * starts with "/". Keyboard state (activeIndex) is owned by the composer;
 * this component only renders and reports hover/click.
 */
export function SlashCommandMenu({
  open,
  items,
  activeIndex,
  onHover,
  onSelect,
}: {
  open: boolean;
  items: SlashItem[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (item: SlashItem) => void;
}) {
  const activeRef = useRef<HTMLDivElement>(null);
  const t = useT();

  /* keep the keyboard-highlighted row visible while navigating */
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 500, damping: 32 }}
          className="material-thick"
          role="listbox"
          style={{
            position: "absolute",
            bottom: "100%",
            left: 12,
            right: 12,
            marginBottom: 8,
            maxHeight: 240,
            overflowY: "auto",
            padding: 6,
            border: "1px solid var(--separator)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 60,
          }}
        >
          {items.map((c, i) => {
            const active = i === activeIndex;
            return (
              <div
                key={`${c.source}/${c.name}`}
                ref={active ? activeRef : undefined}
                role="option"
                aria-selected={active}
                /* mousedown so the composer input never loses focus */
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(c);
                }}
                onMouseEnter={() => onHover(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                  background: active ? "var(--separator)" : "transparent",
                }}
              >
                <span
                  style={{
                    fontSize: 12.5,
                    fontFamily: "var(--font-mono)",
                    fontWeight: 500,
                    color: "var(--accent)",
                    flexShrink: 0,
                  }}
                >
                  /{c.name}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.description}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-tertiary)",
                    flexShrink: 0,
                  }}
                >
                  {c.source === "builtin" ? t("slash.builtin") : c.source}
                </span>
              </div>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
