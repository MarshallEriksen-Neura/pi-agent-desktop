"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@appica/ui-react/collapsible";
import { Spinner } from "@appica/ui-react/spinner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  MoreVertical,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n";
import { useMessageActions } from "@/lib/pi/message-actions";
import { mcpAuthCompleteExample, toolDetail, toolTitle, EDIT_TOOL } from "@/lib/pi/tool-label";
import { htmlEditTarget } from "@/lib/pi/html-preview";
import { isSubagentTool } from "@/lib/pi/subagents";
import { useToolDiffStat } from "@/lib/pi/diff-stat";
import { useSubagentRow } from "./Subagents";
import type { ChatToolCall } from "@/lib/pi/chat";
import { openExternal, openHtmlFile } from "@/lib/open-external";
import { ActivityLine } from "./ActivityLine";
import { DiffStatBadge } from "./DiffStatBadge";
import { ImageLightbox } from "./ImageLightbox";
import { useChat, type ChatMessage } from "@/lib/pi/chat";

// Lazy: keeps streamdown + shiki out of the route's First Load JS.
const StreamdownRenderer = dynamic(
  () => import("./StreamdownRenderer").then((m) => m.StreamdownRenderer),
  { ssr: false },
);

interface MessageBubbleProps {
  m: ChatMessage;
  /** Play the entrance animation. Set false for historical messages so
   *  virtualized re-mounts don't replay the entrance on scroll. */
  animateIn?: boolean;
  /**
   * This message continues the previous one's turn (the message before it is
   * also from the assistant), so it drops its leading margin and the two read
   * as one list instead of two blocks.
   */
  tight?: boolean;
}

/**
 * Does this message put anything on screen?
 *
 * pi opens a new assistant message on every `message_start`, and some of those
 * carry nothing we render — a turn's tool results are fed back as their own
 * message, and providers may bracket a no-op with start/end. Those arrive with
 * empty text, empty thinking and no tool calls. Rendering one still costs its
 * vertical margin, so a few in a row show up as unexplained dead space between
 * two groups of tool rows. Callers filter with this instead, which also keeps
 * Virtuoso from reserving a row per invisible message.
 *
 * `streaming` is deliberately not a reason to render. An empty streaming message
 * is precisely the state AgentPanel's footer loader covers, so counting it here
 * would stack an empty message's margin on top of that loader; it becomes
 * renderable the moment its first token, tool call or error lands.
 */
export function hasRenderableContent(m: ChatMessage): boolean {
  // Written to tolerate a partial message even though the type says otherwise:
  // `load()` restores persisted transcripts and only normalizes `tools`, and
  // remote rows are mapped from a gateway payload. The render paths below use
  // truthy checks for the same reason, so a field this predicate would trip on
  // is a field they would have simply skipped.
  return Boolean(
    m.text ||
      m.thinking ||
      m.tools?.length ||
      m.isError ||
      m.images?.length ||
      m.delivery
  );
}

export function MessageBubble({ m, animateIn = true, tight = false }: MessageBubbleProps) {
  const t = useT();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [showCopy, showCopyOn, hideCopySoon, keepCopy] = useHoverReveal();

  if (m.role === "user") {
    return (
      <>
        <motion.div
          initial={animateIn ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
            margin: "6px 0",
            position: "relative",
          }}
          onMouseEnter={showCopyOn}
          onMouseLeave={hideCopySoon}
        >
        {(m.images?.length ?? 0) > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 6,
              maxWidth: "85%",
            }}
          >
            {m.images!.map((src, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={src}
                alt=""
                title={t("agent.viewImage")}
                onClick={() => setPreviewSrc(src)}
                style={{
                  maxWidth: 140,
                  maxHeight: 140,
                  borderRadius: 12,
                  border: "1px solid var(--separator)",
                  display: "block",
                  cursor: "zoom-in",
                }}
              />
            ))}
          </div>
        )}
        {/* delivered mid-turn (steer/follow-up), or handed over and rejected */}
        {(m.delivery || m.isError) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              fontSize: 10.5,
              color: m.isError ? "var(--danger)" : "var(--text-tertiary)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {m.delivery && (
              <span>
                {t(m.delivery === "steer" ? "message.steered" : "message.queued")}
              </span>
            )}
            {m.isError && (
              <span>{m.errorText || t("message.undelivered")}</span>
            )}
          </div>
        )}
        {m.text && (
          <>
            <div
              style={{
                maxWidth: "85%",
                padding: "8px 13px",
                borderRadius: 16,
                borderBottomRightRadius: 5,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {m.text}
            </div>
            <BubbleCopyButton
              text={m.text}
              visible={showCopy}
              align="end"
              onEnter={keepCopy}
              onLeave={hideCopySoon}
            />
          </>
        )}
        </motion.div>
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      </>
    );
  }

  return (
    <AssistantMessage m={m} animateIn={animateIn} tight={tight} />
  );
}

/** Hover-reveal state with a grace window so the pointer can cross the small
 *  gap between the bubble and its floating copy button without it vanishing. */
function useHoverReveal(): [boolean, () => void, () => void, () => void] {
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const show = () => {
    window.clearTimeout(timer.current);
    setVisible(true);
  };
  const scheduleHide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), 150);
  };
  const keep = () => {
    window.clearTimeout(timer.current);
    setVisible(true);
  };

  return [visible, show, scheduleHide, keep];
}

/** Floating copy pill that fades in below a bubble on hover. */
function BubbleCopyButton({
  text,
  visible,
  align,
  onEnter,
  onLeave,
}: {
  text: string;
  visible: boolean;
  align: "start" | "end";
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const { copyMarkdown } = useMessageActions(text);

  const handleCopy = async () => {
    await copyMarkdown();
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <motion.button
      onClick={handleCopy}
      initial={false}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : -2 }}
      transition={{ duration: 0.12 }}
      aria-label={t("message.copy")}
      onMouseEnter={(e) => {
        onEnter();
        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-sunken)";
      }}
      onMouseLeave={(e) => {
        onLeave();
        (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-base)";
      }}
      style={{
        position: "absolute",
        top: "100%",
        marginTop: 3,
        ...(align === "end" ? { right: 0 } : { left: 0 }),
        zIndex: 3,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 8px",
        borderRadius: 6,
        border: "1px solid var(--separator)",
        background: "var(--bg-base)",
        boxShadow: "var(--shadow-sm)",
        color: copied ? "var(--accent)" : "var(--text-tertiary)",
        fontSize: 11.5,
        cursor: "pointer",
        pointerEvents: visible ? "auto" : "none",
        transition: "background 0.15s ease, color 0.15s ease",
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {t(copied ? "message.copied" : "message.copy")}
    </motion.button>
  );
}

function AssistantMessage({
  m,
  animateIn,
  tight,
}: {
  m: ChatMessage;
  animateIn: boolean;
  tight: boolean;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showCopy, showCopyOn, hideCopySoon, keepCopy] = useHoverReveal();
  const { copyMarkdown, fork } = useMessageActions(m.text, m.id);

  const handleCopy = async () => {
    await copyMarkdown();
    setMenuOpen(false);
  };

  const handleFork = () => {
    fork();
    setMenuOpen(false);
  };

  return (
    <motion.div
      initial={animateIn ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      style={{
        /* One pi turn arrives as several assistant messages (text, then a batch
           of tool calls, then more text). Only the first pays the leading
           margin, so a run of tool rows keeps a single rhythm instead of
           gaining a 16px seam wherever pi happened to split the turn. */
        margin: tight ? "0 0 4px" : "6px 0 10px",
        position: "relative",
      }}
      onMouseEnter={() => {
        setMenuOpen(false);
        showCopyOn();
      }}
      onMouseLeave={hideCopySoon}
    >
      {m.thinking && <ThinkingBlock text={m.thinking} done={!m.streaming} />}

      {m.isError && <ErrorNotice m={m} />}

      {m.tools.map((tool, i) => (
        <div key={tool.id}>
          <ToolRow
            tool={tool}
            // only the freshly-started row slides in; earlier rows are already
            // settled, so a virtualized re-mount must not replay the whole list
            animateIn={animateIn && i === m.tools.length - 1}
          />
          {tool.authUrl && <McpAuthHint url={tool.authUrl} toolName={tool.name} args={tool.args} />}
        </div>
      ))}

      {(m.text || m.streaming) && (
        <div style={{ position: "relative", display: "flex", gap: 4, alignItems: "flex-start", minWidth: 0 }}>
          {/* minWidth:0 — a flex item defaults to min-width:auto, which refuses to
              shrink under its content's intrinsic width. Without it a long URL or
              code line sets the row's width and the reply runs past the panel
              edge instead of wrapping to it. */}
          <div className="sd-bridge" style={{ flex: 1, minWidth: 0, padding: "2px 2px 0" }}>
            <StreamdownRenderer text={m.text} animating={m.streaming} />
          </div>

          {!m.streaming && m.text && (
            <div style={{ position: "relative", flexShrink: 0 }}>
              <motion.button
                onClick={() => setMenuOpen(!menuOpen)}
                whileTap={{ scale: 0.88 }}
                aria-label="Message options"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  border: "none",
                  background: menuOpen ? "var(--bg-base)" : "transparent",
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                  opacity: menuOpen ? 1 : 0,
                  transition: "opacity 0.15s ease, background 0.15s ease",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  if (!menuOpen) {
                    (e.currentTarget as HTMLButtonElement).style.opacity = "0";
                  }
                }}
              >
                <MoreVertical size={14} />
              </motion.button>

              {menuOpen && (
                <motion.div
                  role="menu"
                  initial={{ opacity: 0, scale: 0.95, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ duration: 0.12 }}
                  style={{
                    position: "absolute",
                    top: "100%",
                    right: 0,
                    marginTop: 4,
                    minWidth: 120,
                    borderRadius: 8,
                    border: "1px solid var(--separator)",
                    background: "var(--bg-base)",
                    boxShadow: "var(--shadow-md)",
                    padding: "4px",
                    zIndex: 10,
                  }}
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <button
                    role="menuitem"
                    onClick={handleCopy}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 10px",
                      fontSize: 12.5,
                      textAlign: "left",
                      border: "none",
                      borderRadius: 6,
                      background: "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      transition: "background 0.1s ease",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-sunken)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    {t("message.copy")}
                  </button>
                  <button
                    role="menuitem"
                    onClick={handleFork}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 10px",
                      fontSize: 12.5,
                      textAlign: "left",
                      border: "none",
                      borderRadius: 6,
                      background: "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      transition: "background 0.1s ease",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "var(--bg-sunken)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    {t("message.fork")}
                  </button>
                </motion.div>
              )}
            </div>
          )}
        </div>
      )}

      {!m.streaming && m.text && (
        <BubbleCopyButton
          text={m.text}
          visible={showCopy}
          align="start"
          onEnter={keepCopy}
          onLeave={hideCopySoon}
        />
      )}
    </motion.div>
  );
}

/**
 * One tool call in the transcript. Subagents get the interactive variant: their
 * call returns the moment the worker is forked, so this row — not the tool
 * result — is where the real work is followed and opened. Edits get a variant
 * that reports how many lines moved.
 *
 * Branching on the tool *name* rather than inside one component keeps the store
 * subscription off the ordinary rows, and the branch is stable for a given call.
 */
function ToolRow({ tool, animateIn }: { tool: ChatToolCall; animateIn: boolean }) {
  if (isSubagentTool(tool.name)) {
    return <SubagentToolRow tool={tool} animateIn={animateIn} />;
  }
  if (EDIT_TOOL.test(tool.name)) {
    return <EditToolRow tool={tool} animateIn={animateIn} />;
  }
  return (
    <ActivityLine
      status={tool.status}
      toolName={tool.name}
      title={toolTitle(tool.name, tool.args)}
      detail={toolDetail(tool.args)}
      animateIn={animateIn}
    />
  );
}

/**
 * An edit row, which grows a `+12 −3` badge the moment the write lands. The stat
 * arrives from the agent bridge (keyed by tool call), so a row restored from
 * history — where there was no pre-edit snapshot to diff — stays a plain row.
 *
 * An edit that wrote an HTML page also grows an "open in browser" affordance:
 * the whole point of having the agent write a page is to look at it, and the
 * browser resolves the page's relative assets against the file itself.
 */
function EditToolRow({ tool, animateIn }: { tool: ChatToolCall; animateIn: boolean }) {
  const t = useT();
  const stat = useToolDiffStat(tool.id);
  const changed = stat && (stat.added > 0 || stat.removed > 0);
  // the preview opens the file as it is on disk now, so it only shows once the
  // write has landed — not while the call is still running
  const target = tool.status === "done" ? htmlEditTarget(tool.name, tool.args) : undefined;
  return (
    <ActivityLine
      status={tool.status}
      toolName={tool.name}
      title={toolTitle(tool.name, tool.args)}
      detail={toolDetail(tool.args)}
      animateIn={animateIn}
      trailing={
        <>
          {changed ? <DiffStatBadge stat={stat} /> : undefined}
          {target && (
            <button
              type="button"
              title={t("agent.previewInBrowser")}
              onClick={() => openHtmlFile(target)}
              style={previewButtonStyle}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.color = "var(--text-tertiary)";
              }}
            >
              <ExternalLink size={11} />
              {t("agent.previewInBrowser")}
            </button>
          )}
        </>
      }
    />
  );
}

const previewButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  border: "none",
  background: "transparent",
  color: "var(--text-tertiary)",
  fontSize: 10.5,
  cursor: "pointer",
  padding: 0,
  transition: "color 0.15s ease",
};

function SubagentToolRow({ tool, animateIn }: { tool: ChatToolCall; animateIn: boolean }) {
  const title = toolTitle(tool.name, tool.args);
  const row = useSubagentRow(tool.id, title);

  // Nothing tracked for this call — a transcript restored from history has no
  // snapshot to open, so it stays a plain row rather than a dead control.
  if (!row) {
    return (
      <ActivityLine
        status={tool.status}
        toolName={tool.name}
        title={title}
        detail={toolDetail(tool.args)}
        animateIn={animateIn}
      />
    );
  }

  return (
    <ActivityLine
      status={tool.status}
      toolName={tool.name}
      title={title}
      // while it works, the row reports the worker's current tool instead of the
      // arguments it was launched with
      detail={row.detail ?? toolDetail(tool.args)}
      animateIn={animateIn}
      onClick={row.open}
      active={row.active}
      trailing={row.trailing}
      ariaLabel={row.label}
    />
  );
}

function McpAuthHint({ url, toolName, args }: { url: string; toolName: string; args: unknown }) {
  const t = useT();
  const example = mcpAuthCompleteExample(toolName, args);
  return (
    <div
      role="note"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 7,
        margin: "2px 0 5px 22px",
        padding: "6px 8px",
        borderLeft: "2px solid var(--accent)",
        background: "color-mix(in srgb, var(--accent) 7%, transparent)",
        fontSize: 11.5,
        color: "var(--text-secondary)",
      }}
    >
      <span>{t("mcp.authHint")}</span>
      <button
        type="button"
        onClick={() => openExternal(url)}
        style={{ border: 0, background: "transparent", color: "var(--accent)", cursor: "pointer", padding: 0, font: "inherit" }}
      >
        {t("mcp.openAuthUrl")}
      </button>
      <span style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)", color: "var(--text-tertiary)" }}>
        {url}
      </span>
      {example && (
        <code style={{ flexBasis: "100%", overflowWrap: "anywhere", color: "var(--text-tertiary)", fontSize: 10.5 }}>
          {example}
        </code>
      )}
    </div>
  );
}

/** Map a failure to an actionable hint. Ordered: an auth phrase wins over a
 *  bare status code, since 403 bodies often also mention quotas. */
function errorHintKey(text: string): string | null {
  if (/401|403|unauthorized|forbidden|permission|credential|api[ _-]?key|invalid[ _-]?token|only allows/i.test(text))
    return "agent.errorHintAuth";
  if (/429|rate[ _-]?limit|quota|too many requests|insufficient/i.test(text))
    return "agent.errorHintRate";
  if (/50\d|529|overloaded|internal server error|bad gateway|service unavailable/i.test(text))
    return "agent.errorHintServer";
  if (/econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket|proxy|certificate|timed? ?out/i.test(text))
    return "agent.errorHintNetwork";
  return null;
}

/**
 * In-transcript failure notice.
 *
 * Deliberately quiet: a hairline left rule and a faint tint rather than a
 * filled red card, so a failed turn reads as part of the conversation instead
 * of an alert box. The headline is the one-line summary; raw upstream text goes
 * in a monospace block — inline when it's short, collapsed when it isn't.
 */
function ErrorNotice({ m }: { m: ChatMessage }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const retryLast = useChat((s) => s.retryLast);
  const streaming = useChat((s) => s.streaming);

  const summary = m.errorText ?? t("agent.taskFailed");
  const detail = (m.errorDetail ?? "").trim();
  const hintKey = errorHintKey(`${summary}\n${detail}`);
  // Short single-line detail is the most useful part of the notice — showing it
  // costs one line, so don't bury it behind a disclosure.
  const inlineDetail = detail.length > 0 && detail.length <= 220 && !detail.includes("\n");

  const { copyMarkdown } = useMessageActions(
    detail ? `${summary}\n\n${detail}` : summary,
    m.id
  );

  const handleCopy = async () => {
    await copyMarkdown();
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const detailStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  };

  return (
    <div
      style={{
        margin: "6px 0",
        padding: "8px 11px",
        borderRadius: 8,
        borderLeft: "2px solid color-mix(in srgb, var(--danger) 70%, transparent)",
        background: "color-mix(in srgb, var(--danger) 7%, var(--bg-elevated))",
        fontSize: 12.5,
        lineHeight: 1.55,
        color: "var(--text-primary)",
      }}
    >
      <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}>
        <TriangleAlert
          size={13}
          style={{ color: "var(--danger)", flexShrink: 0, marginTop: 3 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflowWrap: "anywhere" }}>{summary}</div>

          {inlineDetail && <div style={{ ...detailStyle, marginTop: 3 }}>{detail}</div>}

          {hintKey && (
            <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-tertiary)" }}>
              {t(hintKey)}
            </div>
          )}

          {detail && !inlineDetail && (
            <Collapsible open={open} onOpenChange={setOpen} style={{ marginTop: 5 }}>
              <CollapsibleTrigger style={errorActionStyle}>
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {t(open ? "agent.errorLess" : "agent.errorMore")}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div
                  style={{
                    ...detailStyle,
                    marginTop: 5,
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: "var(--bg-sunken)",
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  {detail}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
            {!streaming && (
              <button onClick={() => void retryLast()} style={errorActionStyle}>
                <RotateCcw size={11} />
                {t("agent.errorRetry")}
              </button>
            )}
            <button onClick={handleCopy} style={errorActionStyle}>
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {t(copied ? "agent.errorCopied" : "agent.errorCopy")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const errorActionStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  width: "auto",
  height: "auto",
  padding: "3px 7px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "var(--text-secondary)",
  fontSize: 11.5,
  cursor: "pointer",
};

function ThinkingBlock({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  const t = useT();
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      style={{ margin: "4px 0" }}
    >
      <CollapsibleTrigger
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 11.5,
          color: "var(--agent-thinking)",
          padding: "2px 2px",
          width: "auto",
          height: "auto",
        }}
      >
        <span style={{ fontSize: 10, display: "inline-flex" }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {done ? (
          t("agent.thought")
        ) : (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Spinner style={{ width: 10, height: 10, color: "var(--agent-thinking)" }} />
            {t("agent.thinking")}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          style={{
            fontSize: 12,
            fontStyle: "italic",
            color: "var(--text-tertiary)",
            lineHeight: 1.55,
            padding: "4px 8px",
            borderLeft: "2px solid var(--separator)",
            margin: "2px 0 6px 4px",
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
