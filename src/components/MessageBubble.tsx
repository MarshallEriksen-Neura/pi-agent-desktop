"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@appica/ui-react/collapsible";
import { Spinner } from "@appica/ui-react/spinner";
import { ChevronDown, ChevronRight, MoreVertical } from "lucide-react";
import dynamic from "next/dynamic";
import { useT } from "@/lib/i18n";
import { useMessageActions } from "@/lib/pi/message-actions";
import { ImageLightbox } from "./ImageLightbox";
import type { ChatMessage } from "@/lib/pi/chat";

// Lazy: keeps streamdown + shiki out of the route's First Load JS.
const StreamdownRenderer = dynamic(
  () => import("./StreamdownRenderer").then((m) => m.StreamdownRenderer),
  { ssr: false },
);

interface MessageBubbleProps {
  m: ChatMessage;
}

export function MessageBubble({ m }: MessageBubbleProps) {
  const t = useT();
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  if (m.role === "user") {
    return (
      <>
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
        <ImageLightbox src={previewSrc} onClose={() => setPreviewSrc(null)} />
      </>
    );
  }

  return (
    <AssistantMessage m={m} />
  );
}

function AssistantMessage({ m }: { m: ChatMessage }) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
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
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 28 }}
      style={{ margin: "6px 0 10px", position: "relative" }}
      onMouseEnter={() => setMenuOpen(false)}
    >
      {m.thinking && <ThinkingBlock text={m.thinking} done={!m.streaming} />}

      {m.tools.map((tool) => (
        <div
          key={tool.id}
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
              tool.status === "running"
                ? { opacity: [1, 0.4, 1] }
                : { opacity: 1 }
            }
            transition={
              tool.status === "running"
                ? { repeat: Infinity, duration: 1 }
                : undefined
            }
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              flexShrink: 0,
              background:
                tool.status === "error"
                  ? "var(--danger)"
                  : tool.status === "done"
                    ? "var(--success)"
                    : "var(--agent-thinking)",
            }}
          />
          <span style={{ color: "var(--text-secondary)" }}>{tool.name}</span>
          <span
            style={{
              color: "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {tool.args ? JSON.stringify(tool.args) : ""}
          </span>
        </div>
      ))}

      {(m.text || m.streaming) && (
        <div style={{ position: "relative", display: "flex", gap: 4, alignItems: "flex-start" }}>
          <div className="sd-bridge" style={{ flex: 1, padding: "2px 2px 0" }}>
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
