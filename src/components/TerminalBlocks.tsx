"use client";

import { useTerminalBlocks } from "@/lib/terminal-blocks";
import type { TerminalBlock } from "@/lib/terminal-blocks";
import { AnsiUp } from "ansi_up";
import { ChevronDown, ChevronRight, Copy, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useMemo, useRef, useEffect } from "react";

const ansiUp = new AnsiUp();
ansiUp.use_classes = true;

/** Render ANSI-escaped output as HTML with color classes. */
function AnsiOutput({ text }: { text: string }) {
  const html = useMemo(() => ansiUp.ansi_to_html(text), [text]);
  return (
    <div
      className="ansi-output"
      dangerouslySetInnerHTML={{ __html: html }}
      style={{
        fontFamily: "inherit",
        fontSize: "inherit",
        lineHeight: "inherit",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    />
  );
}

function BlockCard({ block }: { block: TerminalBlock }) {
  const { toggleCollapse } = useTerminalBlocks();
  const outputRef = useRef<HTMLDivElement>(null);

  // auto-scroll to bottom when output grows (only if running)
  useEffect(() => {
    if (block.status === "running" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [block.output, block.status]);

  const elapsed = block.endedAt
    ? block.endedAt - block.startedAt
    : Date.now() - block.startedAt;
  const elapsedStr = elapsed < 1000 ? `${elapsed}ms` : `${(elapsed / 1000).toFixed(1)}s`;

  const statusIcon = () => {
    switch (block.status) {
      case "running":
        return <Loader2 size={14} className="animate-spin" style={{ color: "var(--accent)" }} />;
      case "success":
        return <CheckCircle2 size={14} style={{ color: "var(--success)" }} />;
      case "error":
        return <XCircle size={14} style={{ color: "var(--danger)" }} />;
      case "cancelled":
        return <XCircle size={14} style={{ color: "var(--text-tertiary)" }} />;
    }
  };

  const copyOutput = () => {
    if (block.output) {
      navigator.clipboard.writeText(block.output).catch(() => {});
    }
  };

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--separator)",
        borderRadius: 8,
        marginBottom: 8,
        overflow: "hidden",
      }}
    >
      {/* header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-base)",
          borderBottom: block.collapsed ? "none" : "1px solid var(--separator)",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => toggleCollapse(block.id)}
      >
        {block.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span
          style={{
            fontFamily: "inherit",
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-primary)",
            flex: 1,
          }}
        >
          {block.command}
        </span>
        {statusIcon()}
        <span
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
          }}
        >
          {elapsedStr}
        </span>
        {block.exitCode !== undefined && block.exitCode !== 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--danger)",
            }}
          >
            exit {block.exitCode}
          </span>
        )}
        {block.source === "agent" && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--agent-thinking)",
              background: "var(--accent-muted)",
              padding: "2px 6px",
              borderRadius: 4,
            }}
          >
            agent
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            copyOutput();
          }}
          aria-label="Copy output"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            padding: 4,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Copy size={13} />
        </button>
      </div>

      {/* output */}
      {!block.collapsed && block.output && (
        <div
          ref={outputRef}
          style={{
            maxHeight: 400,
            overflowY: "auto",
            padding: "8px 12px",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--text-primary)",
          }}
        >
          <AnsiOutput text={block.output} />
        </div>
      )}
      {!block.collapsed && !block.output && block.status === "running" && (
        <div
          style={{
            padding: "12px",
            fontSize: 11,
            color: "var(--text-tertiary)",
            fontStyle: "italic",
          }}
        >
          Running…
        </div>
      )}
    </div>
  );
}

/** Block-based terminal view: command cards with ANSI output. */
export function TerminalBlocks() {
  const { blocks } = useTerminalBlocks();

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "8px 12px",
      }}
    >
      {blocks.map((b) => (
        <BlockCard key={b.id} block={b} />
      ))}
      {blocks.length === 0 && (
        <div
          style={{
            padding: "24px",
            textAlign: "center",
            fontSize: 12,
            color: "var(--text-tertiary)",
          }}
        >
          No commands yet — type below or let Pi run commands
        </div>
      )}
    </div>
  );
}
