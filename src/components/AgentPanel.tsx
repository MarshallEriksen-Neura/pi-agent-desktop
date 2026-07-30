"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Virtuoso, type VirtuosoHandle, type Components } from "react-virtuoso";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@appica/ui-react/collapsible";
import { Spinner } from "@appica/ui-react/spinner";
import { useUI, type TaskStatus } from "@/lib/store";
import { useChat, type ChatMessage } from "@/lib/pi/chat";
import { usePi } from "@/lib/pi/store";
import { useSessions } from "@/lib/pi/sessions";
import { useSubagents } from "@/lib/pi/subagents";
import { useT } from "@/lib/i18n";
import {
  filterSlashCommands,
  runBuiltinCommand,
  type SlashItem,
} from "@/lib/pi/commands";
import { SubagentDeck } from "./Subagents";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { MessageBubble } from "./MessageBubble";
import { PiLoader } from "./PiLoader";
import { ComposerInput } from "./ComposerInput";
import { RetryBanner } from "./RetryBanner";
import { IconButton, SectionLabel } from "./primitives";
import {
  Square,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  History,
  SquarePen,
  X,
} from "lucide-react";

const DEMO_TASK_IDS = new Set(["read", "reason", "edit", "test"]);

const DOT: Record<TaskStatus, string> = {
  done: "var(--success)",
  running: "var(--agent-thinking)",
  queued: "var(--text-tertiary)",
};

/** Right rail — real pi conversation stream + demo task strip. */
export function AgentPanel() {
  const { agentTasks, agentRunning, startDemo } = useUI();
  const { messages, streaming, send, abort, queuedPrompts, queuePrompt, clearQueue } = useChat();
  const retrying = useChat((s) => {
    for (const st of s.activeRetries.values()) if (st.status === "loading") return true;
    return false;
  });
  const piStatus = usePi((s) => s.status);
  const piCommands = usePi((s) => s.commands);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // "Waiting for first token": streaming is on, but the AI hasn't produced any
  // visible content yet (no assistant text/thinking/tools/error). This is the
  // gap between sending and the first streamed character — show the Pi loader.
  const waitingForFirstToken = streaming && (() => {
    const last = messages[messages.length - 1];
    if (!last) return true;
    if (last.role === "user") return true;
    return !last.text && !last.thinking && last.tools.length === 0 && !last.isError;
  })();
  const t = useT();

  /** clipboard paste — lift image blobs into data-URL attachments */
  const onComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return; // plain text paste — default behavior
    e.preventDefault();
    for (const f of files) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          const url = reader.result;
          setAttachments((prev) => [...prev, url]);
        }
      };
      reader.readAsDataURL(f);
    }
  };

  /* slash-command menu — open while the draft is "/<partial-name>" */
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery =
    !slashDismissed && draft.startsWith("/") && !draft.includes(" ")
      ? draft.slice(1)
      : null;
  const slashItems = useMemo(
    () =>
      slashQuery !== null
        ? filterSlashCommands(slashQuery, piCommands, t)
        : [],
    [slashQuery, piCommands, t]
  );
  const slashOpen = slashItems.length > 0;

  useEffect(() => setSlashIndex(0), [slashQuery]);

  /** click / ⏎ on a menu row — auto-fill the composer with the command */
  const pickSlash = (item: SlashItem) => {
    setDraft(`/${item.name} `);
  };

  /** Keyboard shortcut: Cmd+Shift+C / Ctrl+Shift+C to copy the last assistant message */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.text);
        if (lastAssistant?.text) {
          navigator.clipboard.writeText(lastAssistant.text).catch(console.error);
        }
      }
    };
    const container = containerRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
      return () => container.removeEventListener('keydown', handleKeyDown);
    }
  }, [messages]);

  /* auto-send queued prompts when agent transitions to idle */
  useEffect(() => {
    if (!streaming && queuedPrompts.length > 0) {
      const nextPrompt = queuedPrompts[0];
      if (nextPrompt) {
        // Remove the first prompt from the queue and send it
        const remaining = queuedPrompts.slice(1);
        clearQueue();
        // Re-add remaining prompts
        remaining.forEach(p => queuePrompt(p));
        send(nextPrompt);
      }
    }
  }, [streaming, queuedPrompts, send, queuePrompt, clearQueue]);

  const submit = () => {
    const text = draft.trim();
    const images = attachments;
    if (!text && images.length === 0) return;
    setDraft("");
    setAttachments([]);
    if (text.toLowerCase() === "demo") {
      if (!agentRunning) startDemo(); // local streaming-edit showcase
      return;
    }
    if (text.toLowerCase() === "agents") {
      useSubagents.getState().runDemo(); // parallel subagent showcase
      return;
    }
    if (runBuiltinCommand(text)) return; // built-ins act locally

    // If streaming, queue the prompt instead of sending immediately
    if (streaming) {
      queuePrompt(text);
      return;
    }

    send(text, images); // extension commands & plain prompts go to pi
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashItems[slashIndex] ?? slashItems[0]);
        return;
      }
      if (e.key === "Escape") {
        setSlashDismissed(true);
        return;
      }
    }
    // Note: Cmd+Enter is handled in ComposerInput component
  };

  const busy = streaming || agentRunning || retrying;

  return (
    <aside
      ref={containerRef}
      className="material"
      tabIndex={-1}
      style={{
        width: 320,
        height: "100%",
        borderLeft: "1px solid var(--separator)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        outline: "none",
      }}
    >
      {/* header — status + session history / new-session entry points */}
      <div style={{ display: "flex", alignItems: "center", paddingRight: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>
            {busy
              ? t("agent.working")
              : t("agent.statusLine", { status: t(`status.${piStatus}`) })}
          </SectionLabel>
        </div>
        <div style={{ display: "flex", alignItems: "center", paddingTop: 8 }}>
          <IconButton
            label={t("agent.history")}
            onClick={() => {
              // history lives in the sidebar sessions list — make sure it shows
              if (!useUI.getState().sidebarOpen) useUI.getState().toggleSidebar();
            }}
          >
            <History size={14} />
          </IconButton>
          <IconButton
            label={t("agent.newSession")}
            onClick={() => useSessions.getState().newSession()}
          >
            <SquarePen size={14} />
          </IconButton>
        </div>
      </div>

      <Virtuoso<ChatMessage>
        ref={virtuosoRef}
        data={messages}
        // streaming? follow new content smoothly only while at the bottom —
        // scrolling up to read history is never interrupted.
        followOutput={(isAtBottom) => (streaming && isAtBottom ? "smooth" : false)}
        // buffer items above/below the viewport so fast scrolls stay filled.
        increaseViewportBy={{ top: 600, bottom: 600 }}
        computeItemKey={(_index, m) => m.id}
        className="material"
        style={{ flex: 1, minHeight: 0 }}
        components={
          {
            // Top of the scroll area (does NOT stick) — subagents, live task
            // strip, and the empty-state hint when there are no messages.
            Header: () => (
              <div style={{ padding: "4px 12px 0" }}>
                {/* subagent deck — parallel workers, tap a card for detail */}
                <SubagentDeck />

                {/* task strip — live pi tool activity (agent-bridge) or the local showcase */}
                {agentRunning &&
                  agentTasks.map((task, i) => (
            <motion.div
              key={task.id}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{
                opacity: task.status === "queued" ? 0.55 : 1,
                y: 0,
                scale: 1,
              }}
              transition={{
                type: "spring",
                stiffness: 320,
                damping: 26,
                delay: i * 0.06,
              }}
              style={{
                display: "flex",
                gap: 10,
                padding: "10px 14px",
                marginBottom: 8,
                borderRadius: "var(--radius-md)",
                background: "var(--bg-base)",
                border: "1px solid var(--separator)",
                boxShadow: "var(--shadow-sm)",
              }}
            >
              <motion.span
                animate={
                  task.status === "running"
                    ? { scale: [1, 1.35, 1], opacity: [1, 0.6, 1] }
                    : { scale: 1, opacity: 1 }
                }
                transition={
                  task.status === "running"
                    ? { repeat: Infinity, duration: 1.1, ease: "easeInOut" }
                    : { type: "spring", stiffness: 400, damping: 20 }
                }
                style={{
                  width: 8,
                  height: 8,
                  marginTop: 5,
                  borderRadius: 99,
                  flexShrink: 0,
                  background: DOT[task.status],
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                  {/* the four demo ids are localized; real pi tool tasks carry their own title */}
                  {DEMO_TASK_IDS.has(task.id) ? t(`demoTask.${task.id}`) : task.title}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  {task.detail}
                </div>
              </div>
            </motion.div>
          ))}

                {/* conversation stream — empty state */}
                {messages.length === 0 && !agentRunning && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: "var(--text-tertiary)",
                      padding: "12px 6px",
                      lineHeight: 1.6,
                    }}
                  >
                    {t("agent.emptyAsk")}
                    <code style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
                      demo
                    </code>
                    {t("agent.emptyOr")}
                    <code style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>
                      agents
                    </code>
                    {t("agent.emptyAfter")}
                  </div>
                )}
              </div>
            ),
            // Bottom of the scroll area — the "Pi is thinking" loader shown
            // during the gap between sending and the first streamed token.
            Footer: () => (
              <div style={{ padding: "0 12px 4px" }}>
                <AnimatePresence>
                  {waitingForFirstToken && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 6 }}
                      transition={{ type: "spring", stiffness: 360, damping: 30 }}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 10,
                        margin: "6px auto 12px",
                        padding: "20px 16px 18px",
                        borderRadius: "var(--radius-md)",
                        background: "var(--bg-base)",
                        border: "1px solid var(--separator)",
                        boxShadow: "var(--shadow-sm)",
                      }}
                    >
                      <PiLoader size={84} />
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 590,
                          color: "var(--text-primary)",
                          letterSpacing: "-0.01em",
                        }}
                      >
                        {t("agent.loading")}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-tertiary)",
                          fontFamily: "var(--font-mono)",
                          letterSpacing: "0.01em",
                        }}
                      >
                        {t("agent.loadingHint")}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ),
          } satisfies Components<ChatMessage>
        }
        itemContent={(index, m) => (
          // Only the latest message plays the entrance animation — historical
          // messages use initial={false} so virtualized re-mounts on scroll
          // don't replay the fade-in.
          <div style={{ padding: "0 12px" }}>
            <MessageBubble
              key={m.id}
              m={m}
              animateIn={index === messages.length - 1}
            />
          </div>
        )}
      />

      {/* composer */}
      <div style={{ position: "relative" }}>
        {/* "/" surfaces built-in + extension commands; a click fills the input */}
        <SlashCommandMenu
          open={slashOpen}
          items={slashItems}
          activeIndex={slashIndex}
          onHover={setSlashIndex}
          onSelect={pickSlash}
        />
        {/* inline retry status — lives in the panel, not a bottom-fixed toast */}
        <div style={{ padding: "0 12px" }}>
          <RetryBanner />
        </div>
        <ComposerInput
          draft={draft}
          setDraft={(value) => {
            setDraft(value);
            setSlashDismissed(false); // typing re-opens an escaped menu
          }}
          attachments={attachments}
          setAttachments={setAttachments}
          streaming={streaming}
          retrying={retrying}
          busy={busy}
          onSubmit={submit}
          onAbort={abort}
          onKeyDown={onComposerKeyDown}
          onPaste={onComposerPaste}
          queuedPrompts={queuedPrompts}
          onClearQueue={clearQueue}
        />
      </div>
    </aside>
  );
}
