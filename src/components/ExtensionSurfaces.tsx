"use client";

import { AnimatePresence, motion } from "motion/react";
import { useExtUi } from "@/lib/pi/ext-ui";

/**
 * The two non-modal pi extension surfaces:
 *   setStatus → a line of live status text under the agent-panel header,
 *   setWidget → pinned text blocks above / below the composer.
 * Both are fire-and-forget on pi's side: extensions push, we display.
 */

/** setStatus entries, joined into one dimmed line. Renders nothing when empty. */
export function ExtStatusLine() {
  const statuses = useExtUi((s) => s.statuses);
  const entries = Object.entries(statuses);

  return (
    <AnimatePresence initial={false}>
      {entries.length > 0 && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.18 }}
          style={{ overflow: "hidden", padding: "0 16px 6px" }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "var(--text-tertiary)",
              lineHeight: 1.5,
            }}
          >
            {entries.map(([key, text]) => (
              <span
                key={key}
                title={key}
                style={{ display: "flex", alignItems: "center", gap: 5 }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 99,
                    background: "var(--agent-thinking)",
                    flexShrink: 0,
                  }}
                />
                {text}
              </span>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** setWidget blocks for one placement — monospace lines in a bordered card. */
export function ExtWidgets({
  placement,
}: {
  placement: "aboveEditor" | "belowEditor";
}) {
  const widgets = useExtUi((s) => s.widgets);
  const entries = Object.entries(widgets).filter(
    ([, w]) => w.placement === placement
  );

  return (
    <AnimatePresence initial={false}>
      {entries.map(([key, w]) => (
        <motion.div
          key={key}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          title={key}
          style={{
            marginBottom: 8,
            padding: "8px 10px",
            borderRadius: 10,
            background: "var(--bg-base)",
            border: "1px solid var(--separator)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            lineHeight: 1.55,
            color: "var(--text-secondary)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {w.lines.join("\n")}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
