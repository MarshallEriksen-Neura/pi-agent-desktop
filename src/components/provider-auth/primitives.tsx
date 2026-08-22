"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@appica/ui-react/button";
import { Check, Copy } from "lucide-react";

/**
 * Presentational primitives for the provider-login surface.
 *
 * Local to this feature for the same reason the remote-control ones are: the
 * colors encode credential semantics (saved / absent), not app-wide conventions.
 */

/** Pill describing whether a provider has a credential saved in pi's auth file. */
export function StatusPill({
  tone,
  children,
}: {
  tone: "signed-in" | "idle";
  children: ReactNode;
}) {
  const signedIn = tone === "signed-in";
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: "nowrap",
        background: signedIn ? "color-mix(in srgb, var(--accent) 18%, transparent)" : "var(--border-soft)",
        color: signedIn ? "var(--accent)" : "var(--muted)",
      }}
    >
      {children}
    </span>
  );
}

/**
 * Monospace block for a value the user may need to move by hand — an
 * authorization URL, a device code, or a shell command.
 */
export function CopyableValue({
  value,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, width: "100%" }}>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 11,
          color: "var(--text)",
          background: "var(--border-soft)",
          borderRadius: 8,
          padding: "8px 10px",
          // URLs are long; keep them fully selectable rather than clipped.
          wordBreak: "break-all",
        }}
      >
        {value}
      </code>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(value)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            })
            // Clipboard access can be denied; the value stays selectable.
            .catch(() => undefined);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        <span style={{ marginLeft: 6 }}>{copied ? copiedLabel : copyLabel}</span>
      </Button>
    </div>
  );
}
