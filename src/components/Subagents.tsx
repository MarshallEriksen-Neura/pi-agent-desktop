"use client";

import { AnimatePresence, motion } from "motion/react";
import { ScrollArea } from "@appica/ui-react/scroll-area";
import { Badge } from "@appica/ui-react/badge";
import { Kbd } from "./primitives";
import { useT } from "@/lib/i18n";
import {
  useSubagents,
  type Subagent,
  type SubagentEvent,
  type SubagentStatus,
} from "@/lib/pi/subagents";
import type { ReactNode } from "react";
import {
  Circle,
  Wrench,
  Sparkles,
  Activity,
  Check,
  AlertTriangle,
  X,
} from "lucide-react";

/* ── shared visual vocabulary ── */

const STATUS_DOT: Record<SubagentStatus, string> = {
  queued: "var(--text-tertiary)",
  running: "var(--agent-thinking)",
  done: "var(--success)",
  error: "var(--danger)",
};

const KIND_ICON: Record<SubagentEvent["kind"], ReactNode> = {
  thinking: <Circle size={11} />,
  tool: <Wrench size={11} />,
  text: <Sparkles size={11} />,
  status: <Activity size={11} />,
};

function StatusDot({ status }: { status: SubagentStatus }) {
  return (
    <motion.span
      animate={
        status === "running"
          ? { scale: [1, 1.3, 1], opacity: [1, 0.6, 1] }
          : { scale: 1, opacity: 1 }
      }
      transition={
        status === "running"
          ? { repeat: Infinity, duration: 1.2, ease: "easeInOut" }
          : { type: "spring", stiffness: 400, damping: 20 }
      }
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        flexShrink: 0,
        background: STATUS_DOT[status],
        boxShadow:
          status === "running" ? "0 0 0 4px var(--accent-muted)" : "none",
      }}
    />
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Deck — stacked cards inside the AgentPanel. Each card carries a layoutId;
   tapping it hands the card off to the detail layer (same layoutId), so the
   card itself appears to grow into the sheet. iOS notification-group feel.
   ──────────────────────────────────────────────────────────────────────────── */

export function SubagentDeck() {
  const agents = useSubagents((s) => s.agents);
  const focusedId = useSubagents((s) => s.focusedId);
  const focus = useSubagents((s) => s.focus);
  const t = useT();

  if (agents.length === 0) return null;

  const running = agents.filter((a) => a.status === "running").length;

  return (
    <div style={{ margin: "2px 0 10px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 4px 6px",
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-tertiary)",
        }}
      >
        {t("subagents.title")}
        {running > 0 && (
          <Badge variant="info" size="sm">
            {t("subagents.running", { n: running })}
          </Badge>
        )}
      </div>

      {agents.map((a) => (
        // the card hides while its detail layer is up — layoutId hands off
        <div key={a.id} style={{ position: "relative" }}>
          {focusedId !== a.id && (
            <motion.button
              layoutId={`subagent-${a.id}`}
              onClick={() => focus(a.id)}
              initial={{ opacity: 0, y: 10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.985 }}
              transition={{ type: "spring", stiffness: 350, damping: 28 }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "11px 13px",
                marginBottom: 7,
                borderRadius: "var(--radius-md)",
                background: "var(--bg-base)",
                border: "1px solid var(--separator)",
                boxShadow: "var(--shadow-sm)",
                cursor: "pointer",
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <StatusDot status={a.status} />
                <motion.span
                  layoutId={`subagent-name-${a.id}`}
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                  }}
                >
                  {a.name}
                </motion.span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10.5,
                    color: "var(--text-tertiary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {a.status === "done" ? (
                    <Check size={12} style={{ color: "var(--success)" }} />
                  ) : a.status === "error" ? (
                    <AlertTriangle size={11} style={{ color: "var(--danger)" }} />
                  ) : (
                    `${Math.round(a.progress * 100)}%`
                  )}
                </span>
              </div>

              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--text-secondary)",
                  marginTop: 3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {a.task}
              </div>

              {/* live last event line — the card "breathes" while working */}
              <AnimatePresence mode="popLayout">
                {a.status === "running" && a.events.length > 0 && (
                  <motion.div
                    key={a.events[a.events.length - 1].id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                    style={{
                      fontSize: 10.5,
                      fontFamily: "var(--font-mono)",
                      color: "var(--text-tertiary)",
                      marginTop: 5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {KIND_ICON[a.events[a.events.length - 1].kind]}{" "}
                    {a.events[a.events.length - 1].label}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* hairline progress along the bottom edge */}
              {a.status === "running" && (
                <motion.div
                  animate={{ width: `${a.progress * 100}%` }}
                  transition={{ type: "spring", stiffness: 120, damping: 24 }}
                  style={{
                    position: "absolute",
                    left: 0,
                    bottom: 0,
                    height: 2,
                    background: "var(--accent)",
                    borderRadius: 2,
                  }}
                />
              )}
            </motion.button>
          )}
          {/* placeholder keeps deck height while a card is expanded */}
          {focusedId === a.id && <div style={{ height: 64, marginBottom: 7 }} />}
        </div>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   Detail — the tapped card grows into a centered sheet (same layoutId).
   Timeline of events, result, Esc / backdrop / ✕ to hand back.
   ──────────────────────────────────────────────────────────────────────────── */

export function SubagentDetail() {
  const agents = useSubagents((s) => s.agents);
  const focusedId = useSubagents((s) => s.focusedId);
  const focus = useSubagents((s) => s.focus);
  const agent = agents.find((a) => a.id === focusedId);
  const t = useT();

  return (
    <AnimatePresence>
      {agent && (
        <motion.div
          key="subagent-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={() => focus(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            display: "grid",
            placeItems: "center",
            background: "rgba(0,0,0,0.32)",
            backdropFilter: "blur(4px)",
          }}
        >
          <motion.div
            layoutId={`subagent-${agent.id}`}
            transition={{ type: "spring", stiffness: 320, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            className="material"
            style={{
              width: 620,
              maxWidth: "90vw",
              maxHeight: "78vh",
              display: "flex",
              flexDirection: "column",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-lg)",
              overflow: "hidden",
            }}
          >
            {/* header — name carries over from the card via layoutId */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "16px 18px 12px",
                borderBottom: "1px solid var(--separator)",
              }}
            >
              <StatusDot status={agent.status} />
              <motion.span
                layoutId={`subagent-name-${agent.id}`}
                style={{
                  fontSize: 15,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                {agent.name}
              </motion.span>
              <Badge
                variant={
                  agent.status === "done"
                    ? "success"
                    : agent.status === "error"
                      ? "error"
                      : "info"
                }
                size="sm"
              >
                {t(`status.${agent.status}`)}
              </Badge>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 11,
                  color: "var(--text-tertiary)",
                }}
              >
                {agent.startedAtLabel}
              </span>
              <button
                onClick={() => focus(null)}
                aria-label={t("common.close")}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--text-tertiary)",
                  cursor: "pointer",
                  fontSize: 14,
                  padding: "2px 4px",
                  borderRadius: 6,
                }}
              >
                <X size={14} />
              </button>
            </div>

            {/* task line */}
            <div
              style={{
                padding: "10px 18px 0",
                fontSize: 13,
                color: "var(--text-secondary)",
              }}
            >
              {agent.task}
            </div>

            {/* event timeline */}
            <ScrollArea
              orientation="vertical"
              scrollShadow
              style={{ flex: 1, minHeight: 0 }}
              viewportProps={{ style: { padding: "12px 18px 16px" } }}
            >
              {agent.events.map((e, i) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    type: "spring",
                    stiffness: 400,
                    damping: 30,
                    delay: Math.min(i * 0.03, 0.3),
                  }}
                  style={{ display: "flex", gap: 12, position: "relative" }}
                >
                  {/* rail */}
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      width: 16,
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color:
                          e.kind === "text"
                            ? "var(--accent)"
                            : e.kind === "thinking"
                              ? "var(--agent-thinking)"
                              : "var(--text-tertiary)",
                        lineHeight: "20px",
                      }}
                    >
                      {KIND_ICON[e.kind]}
                    </span>
                    {i < agent.events.length - 1 && (
                      <div
                        style={{
                          width: 1,
                          flex: 1,
                          minHeight: 8,
                          background: "var(--separator)",
                        }}
                      />
                    )}
                  </div>

                  {/* content */}
                  <div style={{ paddingBottom: 14, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--text-primary)",
                        fontFamily:
                          e.kind === "tool" ? "var(--font-mono)" : "var(--font-ui)",
                        fontStyle: e.kind === "thinking" ? "italic" : "normal",
                      }}
                    >
                      {e.label}
                    </div>
                    {e.detail && (
                      <div
                        style={{
                          fontSize: 11.5,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-tertiary)",
                          marginTop: 2,
                          wordBreak: "break-word",
                        }}
                      >
                        {e.detail}
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}

              {agent.status === "running" && (
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-tertiary)",
                    paddingLeft: 28,
                  }}
                >
                  {t("subagents.working")}
                </div>
              )}
            </ScrollArea>

            {/* result footer */}
            {agent.result && (
              <div
                style={{
                  padding: "12px 18px",
                  borderTop: "1px solid var(--separator)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ color: "var(--success)", fontSize: 13 }}><Check size={13} /></span>
                <span
                  style={{
                    fontSize: 12.5,
                    color: "var(--text-primary)",
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  {agent.result}
                </span>
                <Kbd style={{ background: "transparent", border: "none" }}>
                  esc
                </Kbd>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
