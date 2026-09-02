"use client";

/**
 * An InsetGroup whose header is the disclosure trigger.
 *
 * The merged plugins page carries three sections that are reference rather than
 * work — the commands a plugin contributed, pi's built-in commands, and the
 * local resource paths. They are worth keeping reachable and not worth spending
 * a screenful on, so they collapse. Visual tokens are copied from `InsetGroup`
 * on purpose: an open disclosure has to sit in the same rhythm as the groups
 * above it, not read as a different kind of surface.
 */

import { useState } from "react";
import { motion } from "motion/react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@appica/ui-react/collapsible";
import { ChevronRight } from "lucide-react";

export function DisclosureGroup({
  header,
  count,
  footer,
  defaultOpen = false,
  children,
}: {
  header: string;
  /** shown beside the header — how much is hiding in here */
  count?: number;
  footer?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ marginTop: 22 }}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "0 16px 7px",
            border: "none",
            background: "transparent",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            color: "var(--text-tertiary)",
            fontFamily: "var(--font-ui)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <motion.span
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 34 }}
            style={{ display: "flex" }}
          >
            <ChevronRight size={13} />
          </motion.span>
          {header}
          {count !== undefined && (
            <span style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
              {count}
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div
            style={{
              background: "var(--bg-base)",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--separator)",
              overflow: "hidden",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            {children}
          </div>
          {footer && (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                padding: "7px 16px 0",
                lineHeight: 1.5,
              }}
            >
              {footer}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
