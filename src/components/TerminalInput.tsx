"use client";

import { useRef, KeyboardEvent, useState } from "react";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import { handleBlockInput } from "@/lib/terminal-block-shell";
import { handleTermInput } from "@/lib/terminal-shell";

/**
 * Terminal input row for both view modes.
 * Simpler than ComposerInput — single line, shell-focused.
 */
export function TerminalInput() {
  const { viewMode } = useTerminalBlocks();
  const [value, setValue] = useState("");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = value.trim();
      setValue("");
      if (!cmd) return;

      if (viewMode === "blocks") {
        // feed the command into block-mode handler
        for (const ch of cmd) handleBlockInput(ch);
        handleBlockInput("\r");
      } else {
        // classic mode: feed to xterm line discipline
        for (const ch of cmd) handleTermInput(ch);
        handleTermInput("\r");
      }
      return;
    }

    // Ctrl-C
    if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      setValue("");
      if (viewMode === "blocks") {
        handleBlockInput("\x03");
      } else {
        handleTermInput("\x03");
      }
      return;
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderTop: "1px solid var(--separator)",
        background: "var(--bg-base)",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          fontFamily:
            '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
        }}
      >
        $
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a command…"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        style={{
          flex: 1,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily:
            '"SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
          fontSize: 12,
          color: "var(--text-primary)",
          padding: "4px 0",
        }}
      />
    </div>
  );
}
