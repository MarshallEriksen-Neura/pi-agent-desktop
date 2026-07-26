"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ScrollArea } from "@appica/ui-react/scroll-area";
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
import { ModelPicker } from "./ModelPicker";
import { SlashCommandMenu } from "./SlashCommandMenu";
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
  const { messages, streaming, send, abort } = useChat();
  const piStatus = usePi((s) => s.status);
  const piCommands = usePi((s) => s.commands);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const t = useT();

  /** clipboard paste — lift image blobs into data-URL attachments */
  const onComposerPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
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
    inputRef.current?.focus();
  };

  /* pin to bottom while streaming */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, agentTasks]);

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
    send(text, images); // extension commands & plain prompts go to pi
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    if (e.key === "Enter") submit();
  };

  const busy = streaming || agentRunning;

  return (
    <aside
      className="material"
      style={{
        width: 320,
        height: "100%",
        borderLeft: "1px solid var(--separator)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
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

      <ScrollArea
        orientation="vertical"
        scrollShadow
        style={{ flex: 1, minHeight: 0 }}
        viewportProps={{
          ref: scrollRef as React.Ref<HTMLDivElement>,
          style: { padding: "4px 12px" },
        }}
      >
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

        {/* conversation stream */}
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
            <code
              style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}
            >
              demo
            </code>
            {t("agent.emptyOr")}
            <code
              style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}
            >
              agents
            </code>
            {t("agent.emptyAfter")}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
      </ScrollArea>

      {/* composer */}
      <div
        style={{
          padding: 12,
          borderTop: "1px solid var(--separator)",
          position: "relative",
        }}
      >
        {/* "/" surfaces built-in + extension commands; a click fills the input */}
        <SlashCommandMenu
          open={slashOpen}
          items={slashItems}
          activeIndex={slashIndex}
          onHover={setSlashIndex}
          onSelect={pickSlash}
        />
        {/* pasted-image tray — thumbnails ride above the pill until send */}
        {attachments.length > 0 && (
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 8,
            }}
          >
            {attachments.map((src, i) => (
              <motion.div
                key={`${i}-${src.slice(-16)}`}
                initial={{ opacity: 0, scale: 0.85 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ type: "spring", stiffness: 400, damping: 26 }}
                style={{ position: "relative" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt={t("agent.pastedImage")}
                  style={{
                    width: 52,
                    height: 52,
                    objectFit: "cover",
                    borderRadius: 10,
                    border: "1px solid var(--separator)",
                    display: "block",
                  }}
                />
                <button
                  onClick={() =>
                    setAttachments((prev) => prev.filter((_, j) => j !== i))
                  }
                  aria-label={t("agent.removeImage")}
                  style={{
                    position: "absolute",
                    top: -5,
                    right: -5,
                    width: 16,
                    height: 16,
                    borderRadius: 99,
                    border: "1px solid var(--separator)",
                    background: "var(--bg-base)",
                    color: "var(--text-secondary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <X size={10} />
                </button>
              </motion.div>
            ))}
          </div>
        )}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 14px",
            borderRadius: 99,
            background: "var(--bg-sunken)",
            border: "1px solid var(--separator)",
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSlashDismissed(false); // typing re-opens an escaped menu
            }}
            onKeyDown={onComposerKeyDown}
            onPaste={onComposerPaste}
            placeholder={busy ? t("agent.composerBusy") : t("agent.composerIdle")}
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 13,
              color: "var(--text-primary)",
              fontFamily: "var(--font-ui)",
            }}
          />
          {streaming ? (
            <motion.button
              onClick={abort}
              whileTap={{ scale: 0.85 }}
              title={t("agent.stop")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--danger)",
                fontSize: 13,
                cursor: "pointer",
                padding: 0,
              }}
            >
              <Square size={13} />
            </motion.button>
          ) : (
            <motion.button
              onClick={submit}
              whileTap={{ scale: 0.85 }}
              aria-label={t("agent.send")}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--accent)",
                fontSize: 16,
                cursor: "pointer",
                padding: 0,
              }}
            >
              <ArrowUp size={16} />
            </motion.button>
          )}
        </div>

        {/* model selector — pick any configured model for the next prompt */}
        <div style={{ display: "flex", alignItems: "center", marginTop: 8, paddingLeft: 2 }}>
          <ModelPicker />
        </div>
      </div>
    </aside>
  );
}

/* ── message rendering ── */

function MessageBubble({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 400, damping: 28 }}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          margin: "6px 0",
        }}
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
                style={{
                  maxWidth: 140,
                  maxHeight: 140,
                  borderRadius: 12,
                  border: "1px solid var(--separator)",
                  display: "block",
                }}
              />
            ))}
          </div>
        )}
        {m.text && (
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
              wordBreak: "break-word",
            }}
          >
            {m.text}
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      style={{ margin: "6px 0 10px" }}
    >
      {m.thinking && <ThinkingBlock text={m.thinking} done={!m.streaming} />}

      {m.tools.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            margin: "4px 0",
            borderRadius: 9,
            background: "var(--bg-base)",
            border: "1px solid var(--separator)",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          <motion.span
            animate={
              t.status === "running"
                ? { opacity: [1, 0.4, 1] }
                : { opacity: 1 }
            }
            transition={
              t.status === "running"
                ? { repeat: Infinity, duration: 1 }
                : undefined
            }
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              flexShrink: 0,
              background:
                t.status === "error"
                  ? "var(--danger)"
                  : t.status === "done"
                    ? "var(--success)"
                    : "var(--agent-thinking)",
            }}
          />
          <span style={{ color: "var(--text-secondary)" }}>{t.name}</span>
          <span
            style={{
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {t.args ? JSON.stringify(t.args) : ""}
          </span>
        </div>
      ))}

      {(m.text || m.streaming) && (
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            padding: "2px 2px 0",
          }}
        >
          {m.text}
          {m.streaming && (
            <motion.span
              animate={{ opacity: [1, 0, 1] }}
              transition={{ repeat: Infinity, duration: 0.9 }}
              style={{
                display: "inline-block",
                width: 7,
                height: 14,
                marginLeft: 2,
                verticalAlign: "-2px",
                borderRadius: 2,
                background: "var(--accent)",
              }}
            />
          )}
        </div>
      )}
    </motion.div>
  );
}

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
        <span style={{ fontSize: 10, display: "inline-flex" }}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
        {done ? t("agent.thought") : (
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
