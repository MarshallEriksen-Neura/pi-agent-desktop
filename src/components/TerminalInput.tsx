"use client";

import { ClipboardEvent, KeyboardEvent } from "react";
import { useTerminalBlocks } from "@/lib/terminal-blocks";
import {
  handleBlockInput,
  runBlockLine,
  runPastedLines,
} from "@/lib/terminal-block-shell";
import { handleTermInput } from "@/lib/terminal-shell";

/**
 * Terminal input row for both view modes.
 * Simpler than ComposerInput — single line, shell-focused.
 */
export function TerminalInput() {
  const { viewMode, input, setInput } = useTerminalBlocks();

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const cmd = input.trim();
      setInput("");
      if (!cmd) return;

      if (viewMode === "blocks") {
        runBlockLine(cmd);
      } else {
        // classic mode: feed to xterm's line discipline as one paste-like write
        handleTermInput(cmd + "\r");
      }
      return;
    }

    // Ctrl-C. Only claim it when there is nothing to copy: taking it
    // unconditionally means the field's own Ctrl-C never reaches the clipboard,
    // which is the whole complaint about this terminal.
    if (e.key === "c" && e.ctrlKey && !e.metaKey) {
      const selection = window.getSelection()?.toString();
      const inField =
        e.currentTarget.selectionStart !== e.currentTarget.selectionEnd;
      if (selection || inField) return; // let the browser copy

      e.preventDefault();
      setInput("");
      if (viewMode === "blocks") {
        handleBlockInput("\x03");
      } else {
        handleTermInput("\x03");
      }
      return;
    }
  };

  /**
   * A pasted multi-line command is several commands.
   *
   * Left to itself, `<input type="text">` strips the newlines and concatenates
   * the lines, turning `cd foo` + `echo bar` into `cd fooecho bar` — wrong, and
   * quiet about it. Single-line pastes fall through to the browser so the caret
   * position and undo history keep working normally.
   */
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!text || !/[\r\n]/.test(text)) return;
    e.preventDefault();

    const el = e.currentTarget;
    const start = el.selectionStart ?? input.length;
    const end = el.selectionEnd ?? input.length;
    const merged = input.slice(0, start) + text + input.slice(end);

    if (viewMode === "blocks") {
      setInput(runPastedLines(merged));
      return;
    }
    setInput("");
    handleTermInput(merged);
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
          fontFamily: "var(--font-mono)",
        }}
      >
        $
      </span>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Type a command…"
        autoComplete="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        style={{
          flex: 1,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-primary)",
          padding: "4px 0",
        }}
      />
    </div>
  );
}
